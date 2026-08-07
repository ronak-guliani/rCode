import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";
import type { ModelInfo } from "@github/copilot-sdk";

import {
  buildCopilotEffortDescriptors,
  buildInitialCopilotProviderSnapshot,
  copilotAuthStatusFromMessage,
  copilotModelFromInfo,
  copilotModelsFromInfos,
  makeCopilotClientOptions,
  resolveRuntimeModels,
} from "./CopilotProvider.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const modelInfo = (overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo =>
  ({
    capabilities: {
      supports: { vision: false, reasoningEffort: false },
      limits: { max_context_window_tokens: 128_000 },
    },
    ...overrides,
  }) as ModelInfo;

describe("makeCopilotClientOptions", () => {
  it.effect("maps settings and instance environment to SDK 1.x options", () =>
    Effect.gen(function* () {
      const options = yield* makeCopilotClientOptions(
        decodeCopilotSettings({ binaryPath: "/opt/copilot", homePath: "/tmp/copilot-home" }),
        { cwd: "/tmp/worktree", environment: { GH_TOKEN: "instance-token" } },
      );

      expect(options.workingDirectory).toBe("/tmp/worktree");
      expect(options.baseDirectory).toBe("/tmp/copilot-home");
      expect(options.connection).toMatchObject({
        kind: "stdio",
        path: "/opt/copilot",
        env: { GH_TOKEN: "instance-token" },
      });
      expect(options).not.toHaveProperty("cliPath");
      expect(options).not.toHaveProperty("cwd");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessArchitecture, "arm64"),
    ),
  );
});

describe("buildInitialCopilotProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("seeds the picker with the fallback catalog before the first probe", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(decodeCopilotSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking GitHub Copilot");
      expect(snapshot.models.length).toBeGreaterThan(0);
      // The user's headline ask: every catalog entry advertises its limit.
      for (const model of snapshot.models) {
        expect(model.maxContextWindowTokens).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("appends user-configured custom models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ customModels: ["some-private-preview"] }),
      );
      const custom = snapshot.models.find((model) => model.slug === "some-private-preview");
      expect(custom?.isCustom).toBe(true);
    }),
  );
});

describe("copilotModelFromInfo", () => {
  it("carries the context window and billing multiplier through", () => {
    const model = copilotModelFromInfo(
      modelInfo({
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        billing: { multiplier: 1 },
        capabilities: {
          supports: { vision: true, reasoningEffort: false },
          limits: { max_context_window_tokens: 144_000 },
        },
      }),
    );

    expect(model.slug).toBe("claude-sonnet-4.6");
    expect(model.maxContextWindowTokens).toBe(144_000);
    expect(model.billingMultiplier).toBe(1);
    expect(model.capabilities?.optionDescriptors).toEqual([]);
  });

  it("keeps a zero multiplier — 'included in plan' is meaningful, not missing", () => {
    const model = copilotModelFromInfo(
      modelInfo({ id: "gpt-5-mini", name: "GPT-5 mini", billing: { multiplier: 0 } }),
    );
    expect(model.billingMultiplier).toBe(0);
  });

  it("omits the context window when the provider reports a non-positive limit", () => {
    const model = copilotModelFromInfo(
      modelInfo({
        id: "weird",
        name: "Weird",
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 0 },
        },
      }),
    );
    expect(model.maxContextWindowTokens).toBeUndefined();
  });

  it("exposes only the reasoning efforts the model advertises", () => {
    const model = copilotModelFromInfo(
      modelInfo({
        id: "gpt-5.1-codex",
        name: "GPT-5.1 Codex",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      }),
    );

    const descriptor = model.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("effort");
    expect(descriptor?.type).toBe("select");
    if (descriptor?.type !== "select") throw new Error("expected a select descriptor");
    expect(descriptor.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(descriptor.options.find((option) => option.isDefault)?.id).toBe("medium");
  });
});

describe("buildCopilotEffortDescriptors", () => {
  it("returns no descriptor when the model supports no efforts", () => {
    expect(buildCopilotEffortDescriptors({ supportedEfforts: [] })).toEqual([]);
  });

  it("falls back to 'high' when the provider names no default", () => {
    const [descriptor] = buildCopilotEffortDescriptors({
      supportedEfforts: ["low", "high", "xhigh"],
    });
    if (descriptor?.type !== "select") throw new Error("expected a select descriptor");
    expect(descriptor.options.find((option) => option.isDefault)?.id).toBe("high");
  });

  it("falls back to the strongest level when 'high' is unsupported", () => {
    const [descriptor] = buildCopilotEffortDescriptors({ supportedEfforts: ["low", "medium"] });
    if (descriptor?.type !== "select") throw new Error("expected a select descriptor");
    expect(descriptor.options.find((option) => option.isDefault)?.id).toBe("medium");
  });

  it("ignores efforts Copilot does not define", () => {
    const [descriptor] = buildCopilotEffortDescriptors({
      supportedEfforts: ["low", "ultrathink", "max"],
    });
    if (descriptor?.type !== "select") throw new Error("expected a select descriptor");
    expect(descriptor.options.map((option) => option.id)).toEqual(["low"]);
  });
});

describe("copilotModelsFromInfos", () => {
  it("drops policy-disabled models the account cannot select", () => {
    const models = copilotModelsFromInfos([
      modelInfo({ id: "allowed", name: "Allowed" }),
      modelInfo({
        id: "blocked",
        name: "Blocked",
        policy: { state: "disabled", terms: "" },
      }),
    ]);
    expect(models.map((model) => model.slug)).toEqual(["allowed"]);
  });

  it("keeps unconfigured-policy models, which are still selectable", () => {
    const models = copilotModelsFromInfos([
      modelInfo({ id: "pending", name: "Pending", policy: { state: "unconfigured", terms: "" } }),
    ]);
    expect(models.map((model) => model.slug)).toEqual(["pending"]);
  });

  it("does not restore fallback models when the live catalog is policy-disabled", () => {
    const models = resolveRuntimeModels(
      [
        modelInfo({
          id: "blocked",
          name: "Blocked",
          policy: { state: "disabled", terms: "" },
        }),
      ],
      decodeCopilotSettings({ customModels: ["private-preview"] }),
    );

    expect(models.map((model) => model.slug)).toEqual(["private-preview"]);
  });
});

describe("copilotAuthStatusFromMessage", () => {
  it.each([
    "Not authenticated with GitHub",
    "login required",
    "Please sign in to continue",
    "request failed with status 401",
    // Observed verbatim from the CLI for an account with no Copilot seat.
    'Request models.list failed with message: 403 "unauthorized: not authorized to use this Copilot feature"',
  ])("classifies %j as unauthenticated", (message) => {
    expect(copilotAuthStatusFromMessage(message).status).toBe("unauthenticated");
  });

  it("leaves unrelated failures unknown", () => {
    expect(copilotAuthStatusFromMessage("ENOENT: spawn copilot").status).toBe("unknown");
  });
});
