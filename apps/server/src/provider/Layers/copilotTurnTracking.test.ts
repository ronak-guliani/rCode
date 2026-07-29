import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import type { SessionEvent } from "@github/copilot-sdk";

import {
  assistantUsageFields,
  beginCopilotTurn,
  clearTurnTracking,
  completionTurnRefs,
  isCopilotTurnTerminalEvent,
  markTurnAwaitingCompletion,
  recordTurnUsage,
  type CopilotAssistantUsage,
  type CopilotTurnTrackingState,
} from "./copilotTurnTracking.ts";

const makeState = (): CopilotTurnTrackingState => ({
  currentTurnId: undefined,
  currentProviderTurnId: undefined,
  pendingCompletionTurnId: undefined,
  pendingCompletionProviderTurnId: undefined,
  pendingTurnIds: [],
  pendingTurnUsage: undefined,
});

const usage = (overrides: Partial<CopilotAssistantUsage> = {}): CopilotAssistantUsage =>
  ({ inputTokens: 10, outputTokens: 5, ...overrides }) as CopilotAssistantUsage;

describe("beginCopilotTurn", () => {
  it("binds Copilot's turn id to the id sendTurn already handed out", () => {
    const state = makeState();
    const ours = TurnId.make("copilot-turn-ours");
    state.pendingTurnIds.push(ours);

    beginCopilotTurn(state, TurnId.make("provider-1"));

    expect(state.currentTurnId).toBe(ours);
    expect(state.currentProviderTurnId).toBe(TurnId.make("provider-1"));
    expect(state.pendingTurnIds).toEqual([]);
  });

  it("drains the queue in order across back-to-back turns", () => {
    const state = makeState();
    state.pendingTurnIds.push(TurnId.make("ours-1"), TurnId.make("ours-2"));

    beginCopilotTurn(state, TurnId.make("provider-1"));
    expect(state.currentTurnId).toBe(TurnId.make("ours-1"));

    beginCopilotTurn(state, TurnId.make("provider-2"));
    expect(state.currentTurnId).toBe(TurnId.make("ours-2"));
  });

  it("reuses the last known id for a turn Copilot started on its own", () => {
    const state = makeState();
    state.pendingTurnIds.push(TurnId.make("ours-1"));
    beginCopilotTurn(state, TurnId.make("provider-1"));

    // No matching sendTurn — e.g. Copilot compacting or exiting plan mode.
    beginCopilotTurn(state, TurnId.make("provider-2"));

    expect(state.currentTurnId).toBe(TurnId.make("ours-1"));
    expect(state.currentProviderTurnId).toBe(TurnId.make("provider-2"));
  });

  it("falls back to the provider id when nothing was queued", () => {
    const state = makeState();
    beginCopilotTurn(state, TurnId.make("provider-1"));
    expect(state.currentTurnId).toBe(TurnId.make("provider-1"));
  });

  it("clears usage carried over from the previous turn", () => {
    const state = makeState();
    recordTurnUsage(state, usage());
    beginCopilotTurn(state, TurnId.make("provider-1"));
    expect(state.pendingTurnUsage).toBeUndefined();
  });
});

describe("completion parking", () => {
  it("keeps the turn ids addressable between turn_end and session.idle", () => {
    const state = makeState();
    state.pendingTurnIds.push(TurnId.make("ours-1"));
    beginCopilotTurn(state, TurnId.make("provider-1"));

    // `assistant.turn_end` arrives before the trailing usage/idle events.
    markTurnAwaitingCompletion(state);

    expect(completionTurnRefs(state)).toEqual({
      turnId: TurnId.make("ours-1"),
      providerTurnId: TurnId.make("provider-1"),
    });
  });

  it("reports no refs once the session goes idle", () => {
    const state = makeState();
    state.pendingTurnIds.push(TurnId.make("ours-1"));
    beginCopilotTurn(state, TurnId.make("provider-1"));
    markTurnAwaitingCompletion(state);

    clearTurnTracking(state);

    expect(completionTurnRefs(state)).toEqual({
      turnId: undefined,
      providerTurnId: undefined,
    });
  });
});

describe("assistantUsageFields", () => {
  it("returns nothing when no usage was recorded", () => {
    expect(assistantUsageFields(undefined)).toEqual({});
  });

  it("surfaces cost and model when Copilot reports them", () => {
    const fields = assistantUsageFields(usage({ cost: 0.42, model: "claude-sonnet-4.6" }));
    expect(fields.totalCostUsd).toBe(0.42);
    expect(fields.modelUsage).toEqual({ model: "claude-sonnet-4.6" });
  });

  it("omits cost and model when absent rather than emitting zeros", () => {
    const fields = assistantUsageFields(usage());
    expect(fields.totalCostUsd).toBeUndefined();
    expect(fields.modelUsage).toBeUndefined();
    expect(fields.usage).toBeDefined();
  });
});

describe("isCopilotTurnTerminalEvent", () => {
  it.each(["abort", "session.idle"])("treats %s as terminal", (type) => {
    expect(isCopilotTurnTerminalEvent({ type } as SessionEvent)).toBe(true);
  });

  it.each(["assistant.turn_end", "assistant.message", "tool.execution_complete"])(
    "does not treat %s as terminal",
    (type) => {
      expect(isCopilotTurnTerminalEvent({ type } as SessionEvent)).toBe(false);
    },
  );
});
