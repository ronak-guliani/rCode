import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CopilotSettings,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  PermissionRequest,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  type CopilotClientHandle,
  type CopilotSessionHandle,
  makeCopilotAdapter,
  mapHistoryToTurns,
} from "./CopilotAdapter.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
type UserInputRequest = Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0];
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-copilot-adapter-test-",
}).pipe(Layer.provide(NodeServices.layer));

function makeSession(input?: {
  readonly sessionId?: string;
  readonly onModeSet?: (mode: string) => void;
}): CopilotSessionHandle {
  return {
    sessionId: input?.sessionId ?? "copilot-session",
    disconnect: async () => undefined,
    send: async () => "message-id",
    abort: async () => undefined,
    getEvents: async () => [],
    setModel: async () => undefined,
    rpc: {
      mode: {
        set: async ({ mode }: { mode: string }) => {
          input?.onModeSet?.(mode);
        },
      },
      plan: { read: async () => ({ exists: false, content: null }) },
    },
  } as unknown as CopilotSessionHandle;
}

function makeClient(input: {
  readonly createSession?: (config: SessionConfig) => Promise<CopilotSessionHandle>;
  readonly resumeSession?: (
    sessionId: string,
    config: ResumeSessionConfig,
  ) => Promise<CopilotSessionHandle>;
  readonly onStop?: () => void;
}): CopilotClientHandle {
  return {
    start: async () => undefined,
    listModels: async () => [],
    createSession: input.createSession ?? (async () => makeSession()),
    resumeSession: input.resumeSession ?? (async () => makeSession()),
    stop: async () => {
      input.onStop?.();
      return [];
    },
  } as CopilotClientHandle;
}

const startInput = (threadId: ThreadId) => ({
  threadId,
  runtimeMode: "full-access" as const,
});

describe("CopilotAdapter lifecycle", () => {
  it.effect("stops a client when session creation fails", () => {
    let stopCount = 0;
    const client = makeClient({
      createSession: async () => {
        throw new Error("create failed");
      },
      onStop: () => {
        stopCount += 1;
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
          clientFactory: () => client,
        });
        const result = yield* Effect.result(
          adapter.startSession(startInput(ThreadId.make("failed-start"))),
        );
        expect(result._tag).toBe("Failure");
        expect(stopCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer));
  });

  it.effect("serializes duplicate starts and stops the owned client on scope close", () => {
    let createCount = 0;
    let stopCount = 0;
    const client = makeClient({
      createSession: async () => {
        createCount += 1;
        return makeSession();
      },
      onStop: () => {
        stopCount += 1;
      },
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
            clientFactory: () => client,
          });
          const threadId = ThreadId.make("duplicate-start");
          yield* Effect.all(
            [
              adapter.startSession(startInput(threadId)),
              adapter.startSession(startInput(threadId)),
            ],
            { concurrency: "unbounded" },
          );
          expect(createCount).toBe(1);
        }),
      );
      expect(stopCount).toBe(1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("injects T3 MCP and preserves plan mode emitted during resume", () => {
    const threadId = ThreadId.make("resume-plan");
    let capturedConfig: ResumeSessionConfig | undefined;
    const modeChanges: string[] = [];
    const client = makeClient({
      resumeSession: async (_sessionId, config) => {
        capturedConfig = config;
        config.onEvent?.({
          type: "session.mode_changed",
          data: { newMode: "plan" },
          timestamp: "2026-08-06T00:00:00.000Z",
        } as SessionEvent);
        return makeSession({ onModeSet: (mode) => modeChanges.push(mode) });
      },
    });
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment"),
      threadId,
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("copilot"),
      endpoint: "http://127.0.0.1:3773/mcp",
      authorizationHeader: "Bearer secret",
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
          clientFactory: () => client,
        });
        yield* adapter.startSession({ ...startInput(threadId), resumeCursor: "copilot-session" });
        yield* adapter.sendTurn({ threadId, input: "continue", attachments: [] });

        expect(capturedConfig?.mcpServers?.["t3-code"]).toMatchObject({
          type: "http",
          url: "http://127.0.0.1:3773/mcp",
          headers: { Authorization: "Bearer secret" },
        });
        expect(modeChanges).toEqual([]);
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      Effect.provide(testLayer),
    );
  });

  it.effect("resolves pending interactions before aborting a turn", () => {
    const threadId = ThreadId.make("interrupt-pending");
    let capturedConfig: SessionConfig | undefined;
    const client = makeClient({
      createSession: async (config) => {
        capturedConfig = config;
        return makeSession();
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
          clientFactory: () => client,
        });
        yield* adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
        });
        const approval = Promise.resolve(
          capturedConfig?.onPermissionRequest?.(
            {
              kind: "shell",
              command: "echo blocked",
            } as unknown as PermissionRequest,
            { sessionId: "copilot-session" },
          ),
        );
        const userInput = Promise.resolve(
          capturedConfig?.onUserInputRequest?.(
            {
              question: "Continue?",
              choices: ["Yes", "No"],
            } as unknown as UserInputRequest,
            { sessionId: "copilot-session" },
          ),
        );

        yield* adapter.interruptTurn(threadId);

        expect(yield* Effect.promise(() => approval)).toEqual({
          kind: "denied-interactively-by-user",
        });
        expect(yield* Effect.promise(() => userInput)).toEqual({
          answer: "",
          wasFreeform: true,
        });
      }),
    ).pipe(Effect.provide(testLayer));
  });

  it.effect("keeps assistant usage cumulative across API calls", () => {
    const threadId = ThreadId.make("cumulative-usage");
    let capturedConfig: SessionConfig | undefined;
    const client = makeClient({
      createSession: async (config) => {
        capturedConfig = config;
        return makeSession();
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
          clientFactory: () => client,
        });
        yield* adapter.startSession(startInput(threadId));
        const usageEventsFiber = yield* Effect.forkChild(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "thread.token-usage.updated"),
            Stream.take(2),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;

        capturedConfig?.onEvent?.({
          id: "turn-start",
          type: "assistant.turn_start",
          data: { turnId: "provider-turn" },
          timestamp: "2026-08-07T00:00:00.000Z",
        } as SessionEvent);
        capturedConfig?.onEvent?.({
          id: "usage-1",
          type: "assistant.usage",
          data: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
          timestamp: "2026-08-07T00:00:01.000Z",
        } as SessionEvent);
        capturedConfig?.onEvent?.({
          id: "usage-2",
          type: "assistant.usage",
          data: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 1 },
          timestamp: "2026-08-07T00:00:02.000Z",
        } as SessionEvent);

        const usageEvents = yield* Fiber.join(usageEventsFiber);
        expect(
          usageEvents.map((event) =>
            event.type === "thread.token-usage.updated"
              ? event.payload.usage.totalProcessedTokens
              : undefined,
          ),
        ).toEqual([17, 25]);
      }),
    ).pipe(Effect.provide(testLayer));
  });

  it.effect("remembers accept-for-session decisions for matching permission requests", () => {
    const threadId = ThreadId.make("session-approval");
    let capturedConfig: SessionConfig | undefined;
    const client = makeClient({
      createSession: async (config) => {
        capturedConfig = config;
        return makeSession();
      },
    });
    const request = {
      kind: "shell",
      command: "echo allowed",
      fullCommandText: "echo allowed",
    } as unknown as PermissionRequest;

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
          clientFactory: () => client,
        });
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        const requestEventFiber = yield* Effect.forkChild(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "request.opened"),
            Stream.runHead,
          ),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;

        const firstApproval = capturedConfig?.onPermissionRequest?.(request, {
          sessionId: "copilot-session",
        });
        const requestEvent = Option.getOrThrow(yield* Fiber.join(requestEventFiber));
        if (!requestEvent.requestId) throw new Error("expected approval request id");
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(requestEvent.requestId),
          "acceptForSession",
        );

        expect(yield* Effect.promise(() => Promise.resolve(firstApproval))).toEqual({
          kind: "approved",
        });
        expect(
          yield* Effect.promise(() =>
            Promise.resolve(
              capturedConfig?.onPermissionRequest?.(request, { sessionId: "copilot-session" }),
            ),
          ),
        ).toEqual({ kind: "approved" });
      }),
    ).pipe(Effect.provide(testLayer));
  });

  it.effect("reports an existing session as running while its turn is active", () => {
    const threadId = ThreadId.make("duplicate-running-start");
    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCopilotAdapter(decodeCopilotSettings({}), {
          clientFactory: () => makeClient({}),
        });
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "work", attachments: [] });

        const existing = yield* adapter.startSession(startInput(threadId));
        expect(existing.status).toBe("running");
      }),
    ).pipe(Effect.provide(testLayer));
  });
});

describe("mapHistoryToTurns", () => {
  it("closes persisted turns at assistant.turn_end", () => {
    const snapshot = mapHistoryToTurns(ThreadId.make("history"), [
      {
        type: "assistant.turn_start",
        data: { turnId: "turn-1" },
      } as SessionEvent,
      {
        type: "assistant.message",
        data: { messageId: "message-1", content: "done" },
      } as SessionEvent,
      { type: "assistant.turn_end", data: { turnId: "turn-1" } } as SessionEvent,
      { type: "user.message", data: { content: "next" } } as SessionEvent,
      {
        type: "assistant.turn_start",
        data: { turnId: "turn-2" },
      } as SessionEvent,
    ]);

    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]?.items).toHaveLength(3);
    expect(snapshot.turns[1]?.items).toHaveLength(1);
  });
});
