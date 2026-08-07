/**
 * GitHub Copilot provider adapter.
 *
 * Drives the Copilot CLI through `@github/copilot-sdk`, which speaks JSON-RPC
 * to a `copilot` child process. The SDK is push-based (`session.on(handler)`),
 * so the adapter's job is a translation layer in three directions:
 *
 *   1. `SessionEvent` → `ProviderRuntimeEvent` (`mapSessionEvent`).
 *   2. Copilot's callback-style permission / user-input requests → T3 Code's
 *      request/response events, by parking the promise resolver in a map keyed
 *      by a synthetic request id (`createInteractionHandlers`).
 *   3. T3 Code's turn ids → Copilot's, which it mints itself only once the
 *      assistant starts working (see `./copilotTurnTracking.ts`).
 *
 * Model and reasoning-effort changes go through `session.setModel`, which
 * preserves conversation history and takes effect from the next message —
 * hence `sessionModelSwitch: "in-session"`.
 *
 * @module provider/Layers/CopilotAdapter
 */
import {
  type CopilotSettings,
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type MCPServerConfig,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeCopilotClientOptions } from "./CopilotProvider.ts";
import { loadCopilotMcpServers, resolveCopilotConfigDirectory } from "./copilotMcpServers.ts";
import {
  assistantUsageFields,
  beginCopilotTurn,
  clearTurnTracking,
  completionTurnRefs,
  isCopilotTurnTerminalEvent,
  markTurnAwaitingCompletion,
  recordTurnUsage,
  type CopilotTurnTrackingState,
} from "./copilotTurnTracking.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const USER_INPUT_QUESTION_ID = "answer";
const USER_INPUT_QUESTION_HEADER = "Question";
/** Option descriptor id published by `CopilotProvider`'s effort select. */
const EFFORT_OPTION_ID = "effort";

type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CopilotAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Test seam: substitute a fake Copilot client. */
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClientHandle;
}

interface PendingApprovalRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

interface CopilotUserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

interface CopilotUserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

interface PendingUserInputRequest {
  readonly request: CopilotUserInputRequest;
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: CopilotUserInputResponse) => void;
}

interface CopilotSessionConfiguration {
  readonly model: string | undefined;
  readonly reasoningEffort: CopilotReasoningEffort | undefined;
}

interface ActiveCopilotSession extends CopilotTurnTrackingState {
  readonly client: CopilotClientHandle;
  session: CopilotSessionHandle;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  cwd: string | undefined;
  configDir: string | undefined;
  mcpServers: Record<string, MCPServerConfig> | undefined;
  model: string | undefined;
  reasoningEffort: CopilotReasoningEffort | undefined;
  interactionMode: "default" | "plan" | undefined;
  updatedAt: string;
  lastError: string | undefined;
  toolTitlesByCallId: Map<string, string>;
  pendingApprovalResolvers: Map<string, PendingApprovalRequest>;
  pendingUserInputResolvers: Map<string, PendingUserInputRequest>;
  unsubscribe: () => void;
}

/**
 * The adapter talks to the SDK through these two aliases rather than the
 * concrete classes. Deriving them from `CopilotClient` (instead of hand-rolling
 * structural interfaces) means a real client always satisfies them, while
 * tests can still substitute a stand-in via `clientFactory`.
 */
export type CopilotSessionHandle = Awaited<ReturnType<CopilotClient["createSession"]>>;

export type CopilotClientHandle = Pick<
  CopilotClient,
  "start" | "listModels" | "createSession" | "resumeSession" | "stop"
>;

/** Wall-clock ISO stamp usable from the SDK's synchronous event callbacks. */
const nowIso = (): string => DateTime.formatIso(DateTime.nowUnsafe());

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function makeEventId(prefix: string) {
  return EventId.make(`${prefix}-${NodeCrypto.randomUUID()}`);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return TurnId.make(value);
}

function toRuntimeItemId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeItemId.make(value);
}

function toProviderItemId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return ProviderItemId.make(value);
}

function toRuntimeRequestId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeRequestId.make(value);
}

function toRuntimeTaskId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeTaskId.make(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNonNegativeInt(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.floor(value));
}

function toPositiveInt(value: number | undefined) {
  const normalized = toNonNegativeInt(value);
  return normalized && normalized > 0 ? normalized : undefined;
}

function mapSessionUsageInfo(usage: Extract<SessionEvent, { type: "session.usage_info" }>["data"]) {
  const currentTokens = toNonNegativeInt(usage.currentTokens);
  return {
    usedTokens: currentTokens ?? 0,
    ...(currentTokens !== undefined ? { totalProcessedTokens: currentTokens } : {}),
    ...(toPositiveInt(usage.tokenLimit) ? { maxTokens: toPositiveInt(usage.tokenLimit) } : {}),
  };
}

function mapAssistantUsage(usage: Extract<SessionEvent, { type: "assistant.usage" }>["data"]) {
  const inputTokens = toNonNegativeInt(usage.inputTokens);
  const outputTokens = toNonNegativeInt(usage.outputTokens);
  const cachedInputTokens = toNonNegativeInt(usage.cacheReadTokens);
  const durationMs = toNonNegativeInt(usage.duration);
  const usedTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedInputTokens ?? 0);
  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function isCopilotReasoningEffortValue(value: unknown): value is CopilotReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

/**
 * Read the effort the user picked in the model picker.
 *
 * Copilot only accepts its own four-level ladder, so anything else (a Claude
 * `ultrathink`, a Codex `minimal`) is dropped rather than forwarded — passing
 * an unknown level makes the SDK reject session creation outright.
 */
export function copilotReasoningEffortFromSelection(
  modelSelection: ModelSelection | undefined,
): CopilotReasoningEffort | undefined {
  if (!modelSelection) return undefined;
  const value = getModelSelectionStringOptionValue(modelSelection, EFFORT_OPTION_ID);
  return isCopilotReasoningEffortValue(value) ? value : undefined;
}

export function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  return normalizeString(asRecord(resumeCursor)?.sessionId);
}

function toCopilotSessionMode(interactionMode: "default" | "plan"): "interactive" | "plan" {
  return interactionMode === "plan" ? "plan" : "interactive";
}

function toInteractionMode(mode: string): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

function approvalDecisionToPermissionResult(
  decision: ProviderApprovalDecision,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "mcp":
    case "custom-tool":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return trimToUndefined(String(request.fullCommandText ?? ""));
    case "write":
      return trimToUndefined(String(request.fileName ?? request.intention ?? ""));
    case "read":
      return trimToUndefined(String(request.path ?? request.intention ?? ""));
    case "mcp":
      return trimToUndefined(String(request.toolTitle ?? request.toolName ?? ""));
    case "url":
      return trimToUndefined(String(request.url ?? request.intention ?? ""));
    case "custom-tool":
      return trimToUndefined(String(request.toolName ?? request.toolDescription ?? ""));
    default:
      return undefined;
  }
}

function itemTypeFromToolEvent(event: Extract<SessionEvent, { type: "tool.execution_start" }>) {
  return event.data.mcpToolName ? "mcp_tool_call" : "dynamic_tool_call";
}

function toolDetailFromEvent(data: {
  readonly toolName?: string;
  readonly mcpToolName?: string;
  readonly mcpServerName?: string;
}) {
  return trimToUndefined(
    [data.mcpServerName, data.mcpToolName ?? data.toolName].filter(Boolean).join(" / "),
  );
}

function resolveUserInputAnswer(
  pending: PendingUserInputRequest,
  answers: ProviderUserInputAnswers,
): CopilotUserInputResponse {
  const direct = answers[USER_INPUT_QUESTION_ID];
  const candidate =
    typeof direct === "string"
      ? direct
      : Object.values(answers).find((value): value is string => typeof value === "string");
  const answer = trimToUndefined(candidate) ?? "";
  return {
    answer,
    wasFreeform: !pending.request.choices?.includes(answer),
  };
}

export function makeCopilotAdapter(
  copilotSettings: CopilotSettings,
  options?: CopilotAdapterOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("copilot");
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger = options?.nativeEventLogger;
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ActiveCopilotSession>();
    const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
    // The SDK calls us back on plain promises, outside any fiber. Capturing
    // the context lets those callbacks run Effects (queue offers, logging)
    // without re-entering the runtime from scratch each time.
    const services = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(services);

    const emitRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      runPromise(
        Effect.forEach(events, (event) => PubSub.publish(runtimeEventPubSub, event), {
          discard: true,
        }),
      ).catch(() => undefined);

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) => {
      const existing = threadLocks.get(threadId);
      if (existing) return existing.withPermit(effect);
      const semaphore = Semaphore.makeUnsafe(1);
      threadLocks.set(threadId, semaphore);
      return semaphore.withPermit(effect);
    };

    const writeNativeEvent = (threadId: ThreadId, event: SessionEvent) => {
      if (!nativeEventLogger) return Promise.resolve();
      return runPromise(nativeEventLogger.write(event, threadId)).catch(() => undefined);
    };

    const withRefs = (input: {
      readonly threadId: ThreadId;
      readonly eventId: EventId;
      readonly createdAt: string;
      readonly turnId: TurnId | undefined;
      readonly providerTurnId?: TurnId | undefined;
      readonly itemId: string | undefined;
      readonly requestId: string | undefined;
      readonly rawMethod: string | undefined;
      readonly rawPayload: unknown;
    }): Omit<ProviderRuntimeEvent, "type" | "payload"> => {
      const providerTurnId = input.providerTurnId ?? input.turnId;
      const providerItemId = toProviderItemId(input.itemId);
      const providerRequestId = trimToUndefined(input.requestId);
      return {
        eventId: input.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        createdAt: input.createdAt,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
        ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
        ...(providerTurnId || providerItemId || providerRequestId
          ? {
              providerRefs: {
                ...(providerTurnId ? { providerTurnId } : {}),
                ...(providerItemId ? { providerItemId } : {}),
                ...(providerRequestId ? { providerRequestId } : {}),
              },
            }
          : {}),
        raw: {
          source: input.rawMethod ? "copilot.sdk.session-event" : "copilot.sdk.synthetic",
          ...(input.rawMethod ? { method: input.rawMethod } : {}),
          payload: input.rawPayload,
        },
      };
    };

    const makeSyntheticEvent = (
      threadId: ThreadId,
      type: ProviderRuntimeEvent["type"],
      payload: ProviderRuntimeEvent["payload"],
      extra?: {
        readonly turnId?: TurnId | undefined;
        readonly itemId?: string | undefined;
        readonly requestId?: string | undefined;
      },
    ): ProviderRuntimeEvent =>
      ({
        ...withRefs({
          threadId,
          eventId: makeEventId("copilot-synthetic"),
          createdAt: nowIso(),
          turnId: extra?.turnId,
          itemId: extra?.itemId,
          requestId: extra?.requestId,
          rawMethod: undefined,
          rawPayload: payload,
        }),
        type,
        payload,
      }) as ProviderRuntimeEvent;

    const currentSyntheticTurnId = (record: ActiveCopilotSession) =>
      completionTurnRefs(record).turnId ?? record.currentTurnId;

    const syncInteractionMode = (
      record: ActiveCopilotSession,
      interactionMode: "default" | "plan",
    ) => {
      if (record.interactionMode === interactionMode) {
        return Effect.void;
      }
      return Effect.tryPromise({
        try: async () => {
          await record.session.rpc.mode.set({ mode: toCopilotSessionMode(interactionMode) });
          record.interactionMode = interactionMode;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.mode.set",
            detail: toMessage(cause, "Failed to switch GitHub Copilot interaction mode."),
            cause,
          }),
      });
    };

    const emitLatestProposedPlan = (record: ActiveCopilotSession) =>
      Effect.tryPromise({
        try: () => record.session.rpc.plan.read(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.plan.read",
            detail: toMessage(cause, "Failed to read the GitHub Copilot plan."),
            cause,
          }),
      }).pipe(
        Effect.flatMap((plan) => {
          const planMarkdown = trimToUndefined(plan.content ?? undefined);
          if (!plan.exists || !planMarkdown) {
            return Effect.void;
          }
          return offerRuntimeEvent(
            makeSyntheticEvent(
              record.threadId,
              "turn.proposed.completed",
              { planMarkdown },
              { turnId: currentSyntheticTurnId(record) },
            ),
          );
        }),
      );

    const mapSessionEvent = (
      record: ActiveCopilotSession,
      event: SessionEvent,
    ): ReadonlyArray<ProviderRuntimeEvent> => {
      const currentTurnId = record.currentTurnId;
      const base = (input?: {
        readonly turnId?: TurnId | undefined;
        readonly providerTurnId?: TurnId | undefined;
        readonly itemId?: string | undefined;
        readonly requestId?: string | undefined;
      }) =>
        withRefs({
          threadId: record.threadId,
          eventId: EventId.make(event.id),
          createdAt: event.timestamp,
          // Always report the orchestration turn id T3 Code handed out; the
          // provider's own id rides along in `providerRefs`.
          turnId: currentTurnId ?? input?.providerTurnId ?? input?.turnId,
          providerTurnId: input?.providerTurnId ?? input?.turnId,
          itemId: input?.itemId,
          requestId: input?.requestId,
          rawMethod: event.type,
          rawPayload: event,
        });

      switch (event.type) {
        case "session.start":
        case "session.resume":
          return [
            {
              ...base(),
              type: "session.started",
              payload: {
                message:
                  event.type === "session.resume"
                    ? "Resumed GitHub Copilot session"
                    : "Started GitHub Copilot session",
                resume: event.data,
              },
            },
            {
              ...base(),
              type: "thread.started",
              payload: {
                providerThreadId:
                  event.type === "session.start" ? event.data.sessionId : record.session.sessionId,
              },
            },
          ];
        case "session.info":
        case "session.warning":
          return [
            {
              ...base(),
              type: "runtime.warning",
              payload: { message: event.data.message, detail: event.data },
            },
          ];
        case "session.error":
          return [
            {
              ...base(),
              type: "runtime.error",
              payload: {
                message: event.data.message,
                class: "provider_error",
                detail: event.data,
              },
            },
            {
              ...base(),
              type: "session.state.changed",
              payload: { state: "error", reason: "session.error", detail: event.data },
            },
          ];
        case "session.idle": {
          const idleCompletionRefs = completionTurnRefs(record);
          const idleCompletionEvents: ProviderRuntimeEvent[] =
            idleCompletionRefs.turnId || idleCompletionRefs.providerTurnId
              ? [
                  {
                    ...base(idleCompletionRefs),
                    type: "turn.completed",
                    payload: {
                      state: "completed",
                      ...assistantUsageFields(record.pendingTurnUsage),
                    },
                  } satisfies ProviderRuntimeEvent,
                ]
              : [];
          return [
            ...idleCompletionEvents,
            {
              ...base(),
              type: "session.state.changed",
              payload: { state: "ready", reason: "session.idle" },
            },
            {
              ...base(),
              type: "thread.state.changed",
              payload: { state: "idle", detail: event.data },
            },
          ];
        }
        case "session.title_changed":
          return [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: { name: event.data.title, metadata: event.data },
            },
          ];
        case "session.model_change":
          return [
            {
              ...base(),
              type: "model.rerouted",
              payload: {
                fromModel: event.data.previousModel ?? "unknown",
                toModel: event.data.newModel,
                reason: "session.model_change",
              },
            },
          ];
        case "session.plan_changed":
          return [
            {
              ...base(),
              type: "turn.plan.updated",
              payload: { explanation: `Plan ${event.data.operation}d`, plan: [] },
            },
          ];
        case "session.workspace_file_changed":
          return [
            {
              ...base(),
              type: "files.persisted",
              payload: {
                files: [{ filename: event.data.path, fileId: event.data.path }],
              },
            },
          ];
        case "session.context_changed":
          return [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: { metadata: event.data },
            },
          ];
        case "session.usage_info":
          return [
            {
              ...base(),
              type: "thread.token-usage.updated",
              payload: { usage: mapSessionUsageInfo(event.data) },
            },
          ];
        case "session.task_complete":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId: toRuntimeTaskId(record.threadId) ?? RuntimeTaskId.make(record.threadId),
                status: "completed",
                ...(trimToUndefined(event.data.summary) ? { summary: event.data.summary } : {}),
              },
            },
          ];
        case "assistant.turn_start":
          return [
            {
              ...base({ providerTurnId: toTurnId(event.data.turnId) }),
              type: "turn.started",
              payload: record.model ? { model: record.model } : {},
            },
            {
              ...base({ providerTurnId: toTurnId(event.data.turnId) }),
              type: "session.state.changed",
              payload: { state: "running", reason: "assistant.turn_start" },
            },
          ];
        case "assistant.reasoning":
          return [
            {
              ...base({ itemId: event.data.reasoningId }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                detail: trimToUndefined(event.data.content),
                data: event.data,
              },
            },
          ];
        case "assistant.reasoning_delta":
          return [
            {
              ...base({ itemId: event.data.reasoningId }),
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta: event.data.deltaContent },
            },
          ];
        case "assistant.message":
          return [
            {
              ...base({ itemId: event.data.messageId }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                detail: trimToUndefined(event.data.content),
                data: event.data,
              },
            },
          ];
        case "assistant.message_delta":
          return [
            {
              ...base({ itemId: event.data.messageId }),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: event.data.deltaContent },
            },
          ];
        case "assistant.turn_end":
          // Deliberately silent: the terminal `turn.completed` is emitted at
          // `session.idle`, once trailing usage has landed.
          return [];
        case "assistant.usage": {
          const completionRefs = completionTurnRefs(record);
          const completionBase =
            completionRefs.turnId || completionRefs.providerTurnId ? base(completionRefs) : base();
          return [
            {
              ...completionBase,
              type: "thread.token-usage.updated",
              payload: { usage: mapAssistantUsage(event.data) },
            },
          ];
        }
        case "abort": {
          const abortedTurnRefs = completionTurnRefs(record);
          const abortedBase =
            abortedTurnRefs.turnId || abortedTurnRefs.providerTurnId
              ? base(abortedTurnRefs)
              : base();
          return [
            {
              ...abortedBase,
              type: "turn.aborted",
              payload: { reason: event.data.reason },
            },
          ];
        }
        case "tool.execution_start":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.started",
              payload: {
                itemType: itemTypeFromToolEvent(event),
                status: "inProgress",
                title: event.data.toolName ?? "Tool call",
                ...(toolDetailFromEvent(event.data)
                  ? { detail: toolDetailFromEvent(event.data) }
                  : {}),
                data: event.data,
              },
            },
          ];
        case "tool.execution_progress":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "tool.progress",
              payload: {
                toolUseId: event.data.toolCallId,
                summary: event.data.progressMessage,
              },
            },
          ];
        case "tool.execution_partial_result":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "tool.progress",
              payload: {
                toolUseId: event.data.toolCallId,
                summary: event.data.partialOutput,
              },
            },
          ];
        case "tool.execution_complete": {
          const summary = trimToUndefined(event.data.result?.content);
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.completed",
              payload: {
                itemType: event.data.result?.contents?.some(
                  (content: { type?: string }) => content.type === "terminal",
                )
                  ? "command_execution"
                  : "dynamic_tool_call",
                status: event.data.success ? "completed" : "failed",
                title: record.toolTitlesByCallId.get(event.data.toolCallId) ?? "Tool call",
                ...(summary ? { detail: summary } : {}),
                data: event.data,
              },
            },
            ...(summary
              ? [
                  {
                    ...base({ itemId: event.data.toolCallId }),
                    type: "tool.summary" as const,
                    payload: {
                      summary,
                      precedingToolUseIds: [event.data.toolCallId],
                    },
                  },
                ]
              : []),
          ];
        }
        case "skill.invoked":
          return [
            {
              ...base(),
              type: "task.progress",
              payload: {
                taskId: toRuntimeTaskId(event.data.name) ?? RuntimeTaskId.make(event.data.name),
                description: `Invoked skill ${event.data.name}`,
              },
            },
          ];
        case "subagent.started":
          return [
            {
              ...base(),
              type: "task.started",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.make(event.data.toolCallId),
                description: trimToUndefined(event.data.agentDescription),
                taskType: "subagent",
              },
            },
          ];
        case "subagent.completed":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.make(event.data.toolCallId),
                status: "completed",
                ...(trimToUndefined(event.data.agentDisplayName)
                  ? { summary: event.data.agentDisplayName }
                  : {}),
              },
            },
          ];
        case "subagent.failed":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.make(event.data.toolCallId),
                status: "failed",
                ...(trimToUndefined(event.data.error) ? { summary: event.data.error } : {}),
              },
            },
          ];
        default:
          return [];
      }
    };

    const handleSessionEvent = (record: ActiveCopilotSession, event: SessionEvent) => {
      record.updatedAt = event.timestamp;
      if (event.type === "assistant.turn_start") {
        beginCopilotTurn(record, TurnId.make(event.data.turnId));
      }
      if (event.type === "assistant.usage") {
        recordTurnUsage(record, event.data);
      }
      if (event.type === "session.error") {
        record.lastError = event.data.message;
      }
      if (event.type === "session.model_change") {
        record.model = event.data.newModel;
      }
      if (event.type === "session.mode_changed") {
        record.interactionMode = toInteractionMode(event.data.newMode);
      }
      if (event.type === "tool.execution_start") {
        const toolName = trimToUndefined(event.data.toolName);
        if (toolName) {
          record.toolTitlesByCallId.set(event.data.toolCallId, toolName);
        }
      }

      void writeNativeEvent(record.threadId, event);
      const runtimeEvents = mapSessionEvent(record, event);
      if (runtimeEvents.length > 0) {
        void emitRuntimeEvents(runtimeEvents);
      }
      if (event.type === "session.plan_changed" && event.data.operation !== "delete") {
        void runPromise(emitLatestProposedPlan(record)).catch((cause) => {
          void emitRuntimeEvents([
            makeSyntheticEvent(
              record.threadId,
              "runtime.warning",
              {
                message: "Failed to read GitHub Copilot plan.",
                detail: toMessage(cause, "Failed to read GitHub Copilot plan."),
              },
              { turnId: currentSyntheticTurnId(record) },
            ),
          ]);
        });
      }
      if (event.type === "tool.execution_complete") {
        record.toolTitlesByCallId.delete(event.data.toolCallId);
      }
      if (event.type === "assistant.turn_end") {
        markTurnAwaitingCompletion(record);
      }
      if (event.type === "abort" || event.type === "session.idle") {
        clearTurnTracking(record);
      }
    };

    const createInteractionHandlers = (
      threadId: ThreadId,
      getCurrentTurnId: () => TurnId | undefined,
      getRuntimeMode: () => ProviderSession["runtimeMode"],
      pendingApprovalResolvers: Map<string, PendingApprovalRequest>,
      pendingUserInputResolvers: Map<string, PendingUserInputRequest>,
    ) => {
      const onPermissionRequest = (request: PermissionRequest) =>
        getRuntimeMode() === "full-access"
          ? Promise.resolve<PermissionRequestResult>({ kind: "approved" })
          : new Promise<PermissionRequestResult>((resolve) => {
              const requestId = `copilot-approval-${NodeCrypto.randomUUID()}`;
              const turnId = getCurrentTurnId();
              const requestType = requestTypeFromPermissionRequest(request);
              const detail = requestDetailFromPermissionRequest(request);
              pendingApprovalResolvers.set(requestId, { requestType, turnId, resolve });
              void emitRuntimeEvents([
                makeSyntheticEvent(
                  threadId,
                  "request.opened",
                  {
                    requestType,
                    ...(detail ? { detail } : {}),
                    args: request,
                  },
                  { requestId, turnId },
                ),
              ]);
            });

      const onUserInputRequest = (request: CopilotUserInputRequest) =>
        new Promise<CopilotUserInputResponse>((resolve) => {
          const requestId = `copilot-user-input-${NodeCrypto.randomUUID()}`;
          const turnId = getCurrentTurnId();
          pendingUserInputResolvers.set(requestId, { request, turnId, resolve });
          void emitRuntimeEvents([
            makeSyntheticEvent(
              threadId,
              "user-input.requested",
              {
                questions: [
                  {
                    id: USER_INPUT_QUESTION_ID,
                    header: USER_INPUT_QUESTION_HEADER,
                    question: request.question,
                    options: (request.choices ?? []).map((choice: string) => ({
                      label: choice,
                      description: choice,
                    })),
                  },
                ],
              },
              { requestId, turnId },
            ),
          ]);
        });

      return { onPermissionRequest, onUserInputRequest };
    };

    /**
     * Fail fast on a model/effort combination Copilot would reject.
     *
     * Without this the SDK surfaces the rejection mid-turn as an opaque
     * session error, long after the user pressed send.
     */
    const validateSessionConfiguration = (input: {
      readonly client: CopilotClientHandle;
      readonly threadId: ThreadId;
      readonly model: string | undefined;
      readonly reasoningEffort: CopilotReasoningEffort | undefined;
    }) =>
      Effect.gen(function* () {
        if (!input.model && !input.reasoningEffort) {
          return;
        }

        yield* Effect.tryPromise({
          try: () => input.client.start(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start GitHub Copilot client."),
              cause,
            }),
        });

        const models = yield* Effect.tryPromise({
          try: () => input.client.listModels(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to load GitHub Copilot model metadata."),
              cause,
            }),
        });
        const supportedModels = new Map(models.map((model) => [model.id, model]));
        const selectedModel = input.model ? supportedModels.get(input.model) : undefined;

        if (input.model && !selectedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.model",
            issue: `GitHub Copilot model '${input.model}' is not available on this account.`,
          });
        }

        if (!input.reasoningEffort) {
          return;
        }

        if (!selectedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue:
              "GitHub Copilot reasoning effort requires an explicit supported model selection.",
          });
        }

        const supportedReasoningEfforts = selectedModel.supportedReasoningEfforts ?? [];
        if (supportedReasoningEfforts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort configuration.`,
          });
        }

        if (!supportedReasoningEfforts.includes(input.reasoningEffort)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort '${input.reasoningEffort}'.`,
          });
        }
      });

    /**
     * Apply a new model and/or reasoning effort to a live session.
     *
     * `setModel` keeps the conversation, the session id, and our event
     * subscription intact — it only takes effect from the next message — so a
     * mid-thread model switch costs nothing and needs no re-subscription.
     *
     * There is no way to clear a previously-set effort back to the model's
     * default, so an `undefined` effort simply leaves the last value in place
     * on the SDK side; `record.reasoningEffort` still tracks our intent.
     */
    const reconfigureSession = (
      record: ActiveCopilotSession,
      input: {
        readonly model: string | undefined;
        readonly reasoningEffort: CopilotReasoningEffort | undefined;
      },
    ) => {
      const targetModel = input.model ?? record.model;
      if (!targetModel) {
        // Nothing to switch to — the session keeps Copilot's default model.
        return Effect.sync(() => {
          record.reasoningEffort = input.reasoningEffort;
        });
      }
      return Effect.tryPromise({
        try: async () => {
          await record.session.setModel(
            targetModel,
            input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {},
          );
          record.model = targetModel;
          record.reasoningEffort = input.reasoningEffort;
          record.updatedAt = nowIso();
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.setModel",
            detail: toMessage(cause, "Failed to reconfigure GitHub Copilot session."),
            cause,
          }),
      });
    };

    const getSessionRecord = (threadId: ThreadId) => {
      const record = sessions.get(threadId);
      if (!record) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(record);
    };

    const resolvePendingInteractions = (record: ActiveCopilotSession) => {
      for (const pending of record.pendingApprovalResolvers.values()) {
        pending.resolve({ kind: "denied-interactively-by-user" });
      }
      for (const pending of record.pendingUserInputResolvers.values()) {
        pending.resolve({ answer: "", wasFreeform: true });
      }
      record.pendingApprovalResolvers.clear();
      record.pendingUserInputResolvers.clear();
    };

    const stopRecord = async (record: ActiveCopilotSession) => {
      record.unsubscribe();
      // Never leave the SDK awaiting a promise we will no longer resolve —
      // that would wedge the child process on shutdown.
      resolvePendingInteractions(record);
      try {
        await record.session.disconnect();
      } catch {
        // Best effort: the CLI may already be gone.
      }
      try {
        await record.client.stop();
      } catch {
        // Best effort.
      }
      sessions.delete(record.threadId);
    };

    const toProviderSession = (
      record: ActiveCopilotSession,
      status: ProviderSession["status"],
    ): ProviderSession => ({
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status,
      runtimeMode: record.runtimeMode,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(record.model ? { model: record.model } : {}),
      threadId: record.threadId,
      resumeCursor: record.session.sessionId,
      ...(record.currentTurnId ? { activeTurnId: record.currentTurnId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.lastError ? { lastError: record.lastError } : {}),
    });

    const startSessionUnlocked: CopilotAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}', received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          return toProviderSession(existing, "ready");
        }

        const requestedModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const sessionConfiguration: CopilotSessionConfiguration = {
          model: requestedModelSelection?.model,
          reasoningEffort: copilotReasoningEffortFromSelection(requestedModelSelection),
        };

        const configuredHomePath = trimToUndefined(copilotSettings.homePath);
        const configDir = configuredHomePath
          ? resolveCopilotConfigDirectory(configuredHomePath)
          : undefined;
        const configuredMcpServers = yield* Effect.tryPromise({
          try: () => loadCopilotMcpServers(configDir),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to load GitHub Copilot MCP configuration."),
              cause,
            }),
        });
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const mcpServers: Record<string, MCPServerConfig> | undefined = mcpSession
          ? {
              ...configuredMcpServers,
              "t3-code": {
                type: "http",
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
                tools: ["*"],
              },
            }
          : configuredMcpServers;
        const resumeSessionId = extractResumeSessionId(input.resumeCursor);
        const clientOptions = yield* makeCopilotClientOptions(copilotSettings, {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
        });
        const client = options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
        const pendingApprovalResolvers = new Map<string, PendingApprovalRequest>();
        const pendingUserInputResolvers = new Map<string, PendingUserInputRequest>();
        // Handlers can fire before `createSession` resolves, so they read the
        // record through a mutable binding rather than capturing it.
        let sessionRecord: ActiveCopilotSession | undefined;
        const pendingSessionEvents: SessionEvent[] = [];
        const handlers = createInteractionHandlers(
          input.threadId,
          () => sessionRecord?.currentTurnId,
          () => sessionRecord?.runtimeMode ?? input.runtimeMode,
          pendingApprovalResolvers,
          pendingUserInputResolvers,
        );

        const session = yield* Effect.gen(function* () {
          yield* validateSessionConfiguration({
            client,
            threadId: input.threadId,
            ...sessionConfiguration,
          });

          return yield* Effect.tryPromise({
            try: async () => {
              const config = {
                ...handlers,
                ...(sessionConfiguration.model ? { model: sessionConfiguration.model } : {}),
                ...(sessionConfiguration.reasoningEffort
                  ? { reasoningEffort: sessionConfiguration.reasoningEffort }
                  : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                ...(configDir ? { configDirectory: configDir } : {}),
                ...(mcpServers ? { mcpServers } : {}),
                streaming: true,
                onEvent: (event: SessionEvent) => {
                  if (sessionRecord) {
                    handleSessionEvent(sessionRecord, event);
                  } else {
                    pendingSessionEvents.push(event);
                  }
                },
              };
              return resumeSessionId
                ? client.resumeSession(resumeSessionId, config)
                : client.createSession(config);
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to start GitHub Copilot session."),
                cause,
              }),
          });
        }).pipe(Effect.onError(() => Effect.promise(() => client.stop().catch(() => []))));

        const startedAt = nowIso();
        const record: ActiveCopilotSession = {
          client,
          session,
          threadId: input.threadId,
          createdAt: startedAt,
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          configDir,
          mcpServers,
          model: sessionConfiguration.model,
          reasoningEffort: sessionConfiguration.reasoningEffort,
          interactionMode: undefined,
          updatedAt: startedAt,
          lastError: undefined,
          currentTurnId: undefined,
          currentProviderTurnId: undefined,
          pendingCompletionTurnId: undefined,
          pendingCompletionProviderTurnId: undefined,
          pendingTurnIds: [],
          pendingTurnUsage: undefined,
          toolTitlesByCallId: new Map(),
          pendingApprovalResolvers,
          pendingUserInputResolvers,
          unsubscribe: () => undefined,
        };
        sessionRecord = record;
        for (const event of pendingSessionEvents) {
          handleSessionEvent(record, event);
        }
        sessions.set(input.threadId, record);

        yield* Effect.forEach(
          [
            makeSyntheticEvent(input.threadId, "session.started", {
              message: resumeSessionId
                ? "Resumed GitHub Copilot session"
                : "Started GitHub Copilot session",
              resume: { sessionId: session.sessionId },
            }),
            makeSyntheticEvent(input.threadId, "session.configured", {
              config: {
                ...(input.cwd ? { cwd: input.cwd } : {}),
                ...(sessionConfiguration.model ? { model: sessionConfiguration.model } : {}),
                ...(sessionConfiguration.reasoningEffort
                  ? { reasoningEffort: sessionConfiguration.reasoningEffort }
                  : {}),
                ...(configDir ? { configDir } : {}),
                streaming: true,
              },
            }),
            makeSyntheticEvent(input.threadId, "thread.started", {
              providerThreadId: session.sessionId,
            }),
            makeSyntheticEvent(input.threadId, "session.state.changed", {
              state: "ready",
              reason: "session.started",
            }),
          ],
          offerRuntimeEvent,
          { discard: true },
        );

        return toProviderSession(record, "ready");
      });

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      withThreadLock(input.threadId, startSessionUnlocked(input));

    const sendTurnUnlocked: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(input.threadId);
        const requestedModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const explicitReasoningEffort =
          copilotReasoningEffortFromSelection(requestedModelSelection);
        const nextModel = requestedModelSelection?.model ?? record.model;
        // Switching models drops a stale effort rather than carrying it over:
        // the new model may not support the old level at all.
        const nextReasoningEffort =
          explicitReasoningEffort !== undefined
            ? explicitReasoningEffort
            : requestedModelSelection?.model !== undefined &&
                requestedModelSelection.model !== record.model
              ? undefined
              : record.reasoningEffort;

        const attachments: Array<{ type: "file"; path: string; displayName: string }> = [];
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          attachments.push({
            type: "file",
            path: attachmentPath,
            displayName: attachment.name,
          });
        }

        yield* validateSessionConfiguration({
          client: record.client,
          threadId: input.threadId,
          model: nextModel,
          reasoningEffort: nextReasoningEffort,
        });

        if (nextModel !== record.model || nextReasoningEffort !== record.reasoningEffort) {
          yield* reconfigureSession(record, {
            model: nextModel,
            reasoningEffort: nextReasoningEffort,
          });
        }

        const interactionMode = input.interactionMode ?? record.interactionMode ?? "default";
        yield* syncInteractionMode(record, interactionMode);

        const turnId = TurnId.make(`copilot-turn-${NodeCrypto.randomUUID()}`);
        record.pendingTurnIds.push(turnId);
        record.currentTurnId = turnId;
        record.currentProviderTurnId = undefined;

        yield* Effect.tryPromise({
          try: () =>
            record.session.send({
              prompt: input.input ?? "",
              ...(attachments.length > 0 ? { attachments } : {}),
              mode: "immediate",
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
              cause,
            }),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // Roll back the optimistic turn bookkeeping so a failed send
              // does not leave a phantom turn queued forever.
              record.pendingTurnIds = record.pendingTurnIds.filter(
                (candidate) => candidate !== turnId,
              );
              if (record.currentTurnId === turnId) {
                record.currentTurnId = undefined;
              }
            }),
          ),
        );

        record.updatedAt = nowIso();

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: record.session.sessionId,
        } satisfies ProviderTurnStartResult;
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      withThreadLock(input.threadId, sendTurnUnlocked(input));

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const record = yield* getSessionRecord(threadId);
          resolvePendingInteractions(record);
          yield* Effect.tryPromise({
            try: () => record.session.abort(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.abort",
                detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
                cause,
              }),
          });
        }),
      );

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        const pending = record.pendingApprovalResolvers.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.permission.respond",
            detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
          });
        }
        record.pendingApprovalResolvers.delete(requestId);
        const resolution = approvalDecisionToPermissionResult(decision);
        pending.resolve(resolution);
        yield* offerRuntimeEvent(
          makeSyntheticEvent(
            threadId,
            "request.resolved",
            { requestType: pending.requestType, decision, resolution },
            { requestId, turnId: pending.turnId },
          ),
        );
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        const pending = record.pendingUserInputResolvers.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.userInput.respond",
            detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
          });
        }
        record.pendingUserInputResolvers.delete(requestId);
        pending.resolve(resolveUserInputAnswer(pending, answers));
        yield* offerRuntimeEvent(
          makeSyntheticEvent(
            threadId,
            "user-input.resolved",
            { answers },
            { requestId, turnId: pending.turnId },
          ),
        );
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const record = yield* getSessionRecord(threadId);
          yield* Effect.tryPromise({
            try: () => stopRecord(record),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
                cause,
              }),
          });
        }),
      );

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values()).map((record) =>
          toProviderSession(record, record.currentTurnId ? "running" : "ready"),
        ),
      );

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        return yield* Effect.tryPromise({
          try: async () => mapHistoryToTurns(threadId, await record.session.getEvents()),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.getEvents",
              detail: toMessage(cause, "Failed to read GitHub Copilot thread history."),
              cause,
            }),
        });
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread.rollback",
          detail:
            "The GitHub Copilot SDK does not expose a conversation rollback API for existing sessions.",
        }),
      );

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: async () => {
          await Promise.all(Array.from(sessions.values()).map((record) => stopRecord(record)));
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.make("_all"),
            detail: toMessage(cause, "Failed to stop GitHub Copilot sessions."),
            cause,
          }),
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to stop GitHub Copilot sessions during shutdown.", { cause }),
        ),
        Effect.andThen(PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies CopilotAdapterShape;
  });
}

/**
 * Slice a flat Copilot event log into turns.
 *
 * Events before the first `assistant.turn_start` (session bootstrap, restored
 * user messages) belong to no turn and are dropped — `readThread` is only
 * asked for assistant turns.
 */
export function mapHistoryToTurns(
  threadId: ThreadId,
  events: ReadonlyArray<SessionEvent>,
): ProviderThreadSnapshot {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  let current: { id: TurnId; items: Array<unknown> } | undefined;

  for (const event of events) {
    if (event.type === "assistant.turn_start") {
      current = { id: TurnId.make(event.data.turnId), items: [event] };
      turns.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    current.items.push(event);
    if (isCopilotTurnTerminalEvent(event)) {
      current = undefined;
    }
  }

  return {
    threadId,
    turns: turns.map((turn): ProviderThreadTurnSnapshot => ({ id: turn.id, items: turn.items })),
  };
}
