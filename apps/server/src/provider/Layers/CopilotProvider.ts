/**
 * GitHub Copilot provider snapshot — availability probe and model catalog.
 *
 * Model discovery goes through `CopilotClient.listModels()`, which returns the
 * models the *signed-in account's subscription* actually grants, along with
 * the two things the picker cares about:
 *
 *   - `supportedReasoningEfforts` → an `effort` select descriptor, so the
 *     effort control only offers levels the model really accepts (Copilot
 *     rejects a session configured with an unsupported effort).
 *   - `capabilities.limits.max_context_window_tokens` → `maxContextWindowTokens`,
 *     rendered next to the model name. Copilot's context window is a fixed
 *     per-model limit, not a user-selectable variant, so it is presentational
 *     rather than a `contextWindow` option descriptor.
 *
 * `COPILOT_BUILT_IN_MODELS` is only a fallback for when the CLI cannot be
 * reached (not installed, not signed in, offline). A successful probe always
 * replaces it wholesale with live data.
 *
 * @module provider/Layers/CopilotProvider
 */
import {
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  CopilotClient,
  type CopilotClientOptions,
  type ModelInfo,
  RuntimeConnection,
} from "@github/copilot-sdk";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { normalizeCopilotCliPathOverride, resolveBundledCopilotCliPath } from "./copilotCliPath.ts";
import { resolveCopilotConfigDirectory } from "./copilotMcpServers.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Early Access",
  // The Copilot CLI has a first-class plan mode we forward via `mode.set`.
  showInteractionModeToggle: true,
  // Sessions are reconfigured in place (see `CopilotAdapter.reconfigureSession`),
  // so switching model mid-thread does not require a new thread.
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

/** Copilot's reasoning ladder, ordered weakest → strongest. */
const REASONING_EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;
type CopilotReasoningEffort = (typeof REASONING_EFFORT_ORDER)[number];

const REASONING_EFFORT_LABELS: Record<CopilotReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

/** Copilot's model probe spawns the CLI; give it room on a cold start. */
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

interface CopilotProbeClient {
  readonly start: () => Promise<unknown>;
  readonly listModels: () => Promise<ReadonlyArray<ModelInfo>>;
  readonly stop: () => Promise<unknown>;
}

interface CopilotProbeOptions {
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotProbeClient;
  readonly timeoutMs?: number;
}

const stopClientWithin = Effect.fn("CopilotProvider.stopClientWithin")(function* (
  client: CopilotProbeClient,
  timeoutMs: number,
) {
  const stopFiber = yield* Effect.promise(() => client.stop().catch(() => undefined)).pipe(
    Effect.asVoid,
    Effect.forkDetach({ startImmediately: true }),
  );
  yield* Effect.raceFirst(Fiber.join(stopFiber), Effect.sleep(Duration.millis(timeoutMs)));
});

/**
 * The SDK throws untyped `Error`s. Wrapping them keeps the probe's failure
 * channel tagged, and preserves the human-readable text we sniff for auth
 * state in {@link copilotAuthStatusFromMessage}.
 */
class CopilotProbeError extends Schema.TaggedErrorClass<CopilotProbeError>()("CopilotProbeError", {
  stage: Schema.Literals(["start", "listModels"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.stage === "start"
      ? "Failed to start GitHub Copilot."
      : "Failed to list GitHub Copilot models.";
  }
}

export function isCopilotReasoningEffort(value: unknown): value is CopilotReasoningEffort {
  return (
    typeof value === "string" && (REASONING_EFFORT_ORDER as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Build the `effort` descriptor from the levels a model advertises.
 *
 * `defaultEffort` comes from Copilot's own `defaultReasoningEffort` when
 * present; otherwise we prefer `high`, then the strongest supported level, so
 * the picker always has a marked default.
 */
export function buildCopilotEffortDescriptors(input: {
  readonly supportedEfforts: ReadonlyArray<string>;
  readonly defaultEffort?: string | undefined;
}) {
  const supported = REASONING_EFFORT_ORDER.filter((effort) =>
    input.supportedEfforts.includes(effort),
  );
  if (supported.length === 0) {
    return [];
  }

  const preferred = isCopilotReasoningEffort(input.defaultEffort) ? input.defaultEffort : undefined;
  const defaultEffort =
    preferred && supported.includes(preferred)
      ? preferred
      : supported.includes("high")
        ? "high"
        : supported[supported.length - 1];

  return [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      description: "Reasoning effort passed to the Copilot session.",
      options: supported.map((effort) => ({
        value: effort,
        label: REASONING_EFFORT_LABELS[effort],
        ...(effort === defaultEffort ? { isDefault: true as const } : {}),
      })),
    }),
  ];
}

function capabilitiesForEfforts(input: {
  readonly supportedEfforts: ReadonlyArray<string>;
  readonly defaultEffort?: string | undefined;
}): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: buildCopilotEffortDescriptors(input),
  });
}

function staticModel(input: {
  readonly slug: string;
  readonly name: string;
  readonly maxContextWindowTokens: number;
  readonly billingMultiplier: number;
  readonly efforts?: ReadonlyArray<CopilotReasoningEffort>;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.name,
    isCustom: false,
    maxContextWindowTokens: input.maxContextWindowTokens,
    billingMultiplier: input.billingMultiplier,
    capabilities: input.efforts
      ? capabilitiesForEfforts({ supportedEfforts: input.efforts })
      : EMPTY_CAPABILITIES,
  };
}

/**
 * Offline fallback catalog of Copilot subscription models.
 *
 * These figures mirror what the Copilot API reports for a paid plan at the
 * time of writing; they exist so the picker is not empty before the first
 * successful probe. Every field here is replaced by live `listModels()` data
 * as soon as the CLI answers, so treat them as a seed, not a source of truth.
 */
export const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  staticModel({
    slug: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    maxContextWindowTokens: 144_000,
    billingMultiplier: 1,
  }),
  staticModel({
    slug: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    maxContextWindowTokens: 144_000,
    billingMultiplier: 10,
  }),
  staticModel({
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    maxContextWindowTokens: 144_000,
    billingMultiplier: 0.33,
  }),
  staticModel({
    slug: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    maxContextWindowTokens: 128_000,
    billingMultiplier: 1,
    efforts: ["low", "medium", "high", "xhigh"],
  }),
  staticModel({
    slug: "gpt-5-mini",
    name: "GPT-5 mini",
    maxContextWindowTokens: 128_000,
    billingMultiplier: 0,
    efforts: ["low", "medium", "high"],
  }),
  staticModel({
    slug: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    maxContextWindowTokens: 128_000,
    billingMultiplier: 1,
  }),
];

function trimToUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toPositiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export const makeCopilotClientOptions = Effect.fn("makeCopilotClientOptions")(function* (
  settings: CopilotSettings,
  overrides?: {
    readonly cwd?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  },
): Effect.fn.Return<CopilotClientOptions, never, never> {
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const cliPath =
    normalizeCopilotCliPathOverride(settings.binaryPath) ??
    resolveBundledCopilotCliPath({ platform, arch });
  const connection =
    cliPath || overrides?.environment
      ? RuntimeConnection.forStdio({
          ...(cliPath ? { path: cliPath } : {}),
          ...(overrides?.environment ? { env: definedEnvironment(overrides.environment) } : {}),
        })
      : undefined;
  return {
    ...(connection ? { connection } : {}),
    ...(overrides?.cwd ? { workingDirectory: overrides.cwd } : {}),
    ...(settings.homePath.trim()
      ? { baseDirectory: resolveCopilotConfigDirectory(settings.homePath.trim()) }
      : {}),
    logLevel: "error",
  } satisfies CopilotClientOptions;
});

/** Translate one live `ModelInfo` into a picker entry. */
export function copilotModelFromInfo(model: ModelInfo): ServerProviderModel {
  const contextWindow = toPositiveInt(model.capabilities?.limits?.max_context_window_tokens);
  const multiplier = model.billing?.multiplier;
  const supportedEfforts = model.supportedReasoningEfforts ?? [];

  return {
    slug: model.id,
    name: trimToUndefined(model.name) ?? model.id,
    isCustom: false,
    ...(contextWindow !== undefined ? { maxContextWindowTokens: contextWindow } : {}),
    ...(typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier >= 0
      ? { billingMultiplier: multiplier }
      : {}),
    capabilities: capabilitiesForEfforts({
      supportedEfforts,
      ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
    }),
  };
}

/**
 * Drop models the account cannot actually use. Copilot returns
 * policy-gated models (org admin has not enabled them) in the same list as
 * usable ones; selecting those fails at session start with an opaque error.
 */
function isSelectableModel(model: ModelInfo): boolean {
  return model.policy === undefined || model.policy.state !== "disabled";
}

export function copilotModelsFromInfos(
  models: ReadonlyArray<ModelInfo>,
): ReadonlyArray<ServerProviderModel> {
  return models
    .filter(isSelectableModel)
    .map(copilotModelFromInfo)
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function fallbackModels(settings: CopilotSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    COPILOT_BUILT_IN_MODELS,
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function resolveRuntimeModels(
  models: ReadonlyArray<ModelInfo>,
  settings: CopilotSettings,
): ReadonlyArray<ServerProviderModel> {
  const runtimeModels = copilotModelsFromInfos(models);
  return providerModelsFromSettings(runtimeModels, settings.customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * The SDK surfaces auth failures as ordinary `Error`s with human text, so
 * sniffing the message is the only signal available for distinguishing
 * "not signed in" from "CLI is broken".
 */
export function copilotAuthStatusFromMessage(message: string): Pick<ServerProviderAuth, "status"> {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("not authenticated") ||
    normalized.includes("unauthenticated") ||
    normalized.includes("unauthorized") ||
    normalized.includes("login required") ||
    normalized.includes("not logged in") ||
    normalized.includes("sign in") ||
    normalized.includes("sign-in") ||
    normalized.includes("authentication required") ||
    normalized.includes("401") ||
    // An account without a Copilot entitlement fails `models.list` with
    // `403 unauthorized: not authorized to use this Copilot feature` —
    // actionable in exactly the same way as a missing login.
    normalized.includes("403")
  ) {
    return { status: "unauthenticated" };
  }
  return { status: "unknown" };
}

function isInstalledFromMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    !normalized.includes("enoent") &&
    !normalized.includes("not found") &&
    !normalized.includes("spawn")
  );
}

function statusFromMessage(message: string): Exclude<ServerProviderState, "disabled"> {
  return copilotAuthStatusFromMessage(message).status === "unauthenticated" ? "error" : "warning";
}

export function buildInitialCopilotProviderSnapshot(
  settings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = fallbackModels(settings);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot availability…",
      },
    });
  });
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment?: NodeJS.ProcessEnv,
  options?: CopilotProbeOptions,
): Effect.fn.Return<ServerProviderDraft, never, never> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const clientOptions = yield* makeCopilotClientOptions(
    settings,
    environment ? { environment } : undefined,
  );
  const client = options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
  const timeoutMs = options?.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
  const probe = yield* Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => client.start(),
      catch: (cause) => new CopilotProbeError({ stage: "start", cause }),
    });
    const models = yield* Effect.tryPromise({
      try: () => client.listModels(),
      catch: (cause) => new CopilotProbeError({ stage: "listModels", cause }),
    });
    return { models };
  }).pipe(
    // `client.stop()` must run whether the probe succeeded, failed, or timed
    // out — otherwise every refresh leaks a CLI child process.
    Effect.ensuring(stopClientWithin(client, timeoutMs)),
    Effect.timeoutOption(timeoutMs),
    Effect.result,
  );

  if (Result.isSuccess(probe) && Option.isSome(probe.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: resolveRuntimeModels(probe.success.value.models, settings),
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: {
          status: "authenticated",
          type: "github",
          label: "GitHub Copilot",
        },
      },
    });
  }

  if (Result.isSuccess(probe)) {
    yield* Effect.logWarning(`GitHub Copilot model discovery timed out after ${timeoutMs}ms.`);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `GitHub Copilot CLI did not respond within ${timeoutMs}ms.`,
      },
    });
  }

  const message = toMessage(probe.failure.cause, probe.failure.message);
  const auth = copilotAuthStatusFromMessage(message);
  yield* Effect.logWarning("GitHub Copilot health check failed.", {
    errorTag: probe.failure._tag,
  });

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fallbackModels(settings),
    probe: {
      installed: isInstalledFromMessage(message),
      version: null,
      status: statusFromMessage(message),
      auth,
      message:
        auth.status === "unauthenticated"
          ? "GitHub Copilot is not signed in, or this account has no Copilot subscription. Run `copilot` in a terminal, sign in with `/login`, then refresh."
          : message,
    },
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
