import { ProviderDriverKind } from "@t3tools/contracts";
import {
  ClaudeAI,
  CursorIcon,
  GithubCopilotIcon,
  GrokIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("copilot")]: GithubCopilotIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isLegacy?: boolean | undefined;
  /** Fixed per-model context window reported by the provider, in tokens. */
  maxContextWindowTokens?: number | undefined;
  /** Premium-request multiplier for subscription-metered providers. */
  billingMultiplier?: number | undefined;
};

/**
 * Render a context window as a compact token count ("128k", "1M").
 *
 * Uses the powers-of-ten convention providers publish in their own docs
 * (128000 → "128k"), not binary units, so the label matches what users see
 * on the provider's pricing page.
 */
export function formatContextWindowTokens(tokens: number | undefined): string | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return String(tokens);
}

/**
 * Label for the premium-request cost of one turn. `0` is meaningful (the
 * model is included in the base plan), so it gets its own label rather than
 * being hidden as falsy.
 */
export function formatBillingMultiplier(multiplier: number | undefined): string | undefined {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0) {
    return undefined;
  }
  if (multiplier === 0) {
    return "Included";
  }
  return `${Number.isInteger(multiplier) ? multiplier : multiplier.toFixed(2)}×`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
