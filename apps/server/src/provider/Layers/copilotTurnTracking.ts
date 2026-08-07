/**
 * Turn correlation for the GitHub Copilot adapter.
 *
 * Copilot mints its own `turnId` when the assistant starts working, but
 * `sendTurn` has to return an orchestration turn id *before* that happens.
 * We therefore keep both ids side by side: `currentTurnId` is the one T3 Code
 * handed to the caller, `currentProviderTurnId` is Copilot's.
 *
 * The `pendingCompletion*` pair exists because `assistant.turn_end` arrives
 * before the trailing `assistant.usage` and `session.idle` events. Clearing
 * the current ids at `turn_end` would orphan those late events, so we park
 * the ids until the session actually goes idle.
 *
 * @module provider/Layers/copilotTurnTracking
 */
import { TurnId } from "@t3tools/contracts";
import type { SessionEvent } from "@github/copilot-sdk";

export type CopilotAssistantUsage = Extract<SessionEvent, { type: "assistant.usage" }>["data"];

export interface CopilotTurnTrackingState {
  currentTurnId: TurnId | undefined;
  currentProviderTurnId: TurnId | undefined;
  pendingCompletionTurnId: TurnId | undefined;
  pendingCompletionProviderTurnId: TurnId | undefined;
  pendingTurnIds: Array<TurnId>;
  pendingTurnUsage: CopilotAssistantUsage | undefined;
}

/** Ids to stamp on completion-ish events (`turn.completed`, `turn.aborted`). */
export function completionTurnRefs(state: CopilotTurnTrackingState): {
  readonly turnId: TurnId | undefined;
  readonly providerTurnId: TurnId | undefined;
} {
  return {
    turnId: state.pendingCompletionTurnId ?? state.currentTurnId,
    providerTurnId: state.pendingCompletionProviderTurnId ?? state.currentProviderTurnId,
  };
}

/**
 * Bind Copilot's turn id to the orchestration turn id queued by `sendTurn`.
 *
 * `pendingTurnIds` is a queue rather than a single slot: Copilot can start a
 * follow-up turn on its own (compaction, plan mode hand-off) without a
 * matching `sendTurn`, and the queue drains in order so those extra turns
 * reuse the last known id instead of desynchronising every later turn.
 */
export function beginCopilotTurn(state: CopilotTurnTrackingState, providerTurnId: TurnId): void {
  state.pendingCompletionTurnId = undefined;
  state.pendingCompletionProviderTurnId = undefined;
  state.pendingTurnUsage = undefined;
  state.currentProviderTurnId = providerTurnId;
  state.currentTurnId = state.pendingTurnIds.shift() ?? state.currentTurnId ?? providerTurnId;
}

export function markTurnAwaitingCompletion(state: CopilotTurnTrackingState): void {
  state.pendingCompletionTurnId = state.currentTurnId ?? state.pendingCompletionTurnId;
  state.pendingCompletionProviderTurnId =
    state.currentProviderTurnId ?? state.pendingCompletionProviderTurnId;
}

export function recordTurnUsage(
  state: CopilotTurnTrackingState,
  usage: CopilotAssistantUsage,
): void {
  state.pendingTurnUsage = usage;
}

export function clearTurnTracking(state: CopilotTurnTrackingState): void {
  state.currentTurnId = undefined;
  state.currentProviderTurnId = undefined;
  state.pendingCompletionTurnId = undefined;
  state.pendingCompletionProviderTurnId = undefined;
  state.pendingTurnIds = [];
  state.pendingTurnUsage = undefined;
}

export function assistantUsageFields(usage: CopilotAssistantUsage | undefined): {
  usage?: CopilotAssistantUsage;
  modelUsage?: { model: string };
  totalCostUsd?: number;
} {
  if (!usage) {
    return {};
  }

  return {
    usage,
    ...(usage.cost !== undefined ? { totalCostUsd: usage.cost } : {}),
    ...(usage.model ? { modelUsage: { model: usage.model } } : {}),
  };
}

export function isCopilotTurnTerminalEvent(event: SessionEvent): boolean {
  return event.type === "abort" || event.type === "session.idle";
}
