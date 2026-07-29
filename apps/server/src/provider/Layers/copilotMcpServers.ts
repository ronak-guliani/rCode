// @effect-diagnostics nodeBuiltinImport:off - reads the Copilot CLI's own
// config file from a plain promise, outside the Effect runtime.
/**
 * Read the Copilot CLI's own `mcp-config.json` and translate it into the
 * shape `CopilotClient.createSession` expects.
 *
 * The CLI stores MCP servers outside the SDK, so a session started through
 * the SDK gets none of the user's configured servers unless we forward them
 * explicitly. Reading the CLI's file (rather than inventing a T3-Code-specific
 * one) means `copilot mcp add ...` keeps working and the same servers show up
 * in both the terminal CLI and T3 Code.
 *
 * @module provider/Layers/copilotMcpServers
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { MCPServerConfig } from "@github/copilot-sdk";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    const normalized = asNonEmptyString(item);
    return normalized ? [normalized] : [];
  });
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const entries = Object.entries(record).flatMap(([key, item]) => {
    const normalized = asNonEmptyString(item);
    return normalized ? [[key, normalized] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** An absent `tools` list means "expose everything", matching the CLI. */
function normalizeTools(value: unknown): string[] {
  return asStringArray(value) ?? ["*"];
}

function toMcpServerConfig(entry: unknown): MCPServerConfig | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }

  const type = asNonEmptyString(record.type);
  const command = asNonEmptyString(record.command);
  const args = asStringArray(record.args) ?? [];
  const url = asNonEmptyString(record.url);
  const tools = normalizeTools(record.tools);
  const timeout = asTimeout(record.timeout);
  const env = asStringRecord(record.env);
  const cwd = asNonEmptyString(record.cwd);
  const headers = asStringRecord(record.headers);

  if (command && (type === undefined || type === "local" || type === "stdio")) {
    return {
      type: "local",
      command,
      args,
      tools,
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  if (url && (type === undefined || type === "http" || type === "sse")) {
    return {
      type: type === "sse" ? "sse" : "http",
      url,
      tools,
      ...(headers ? { headers } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  return undefined;
}

/**
 * Directories to search, most specific first. Copilot CLI moved from
 * `~/.copilot` to the XDG-style `~/.config/copilot`; both are still in the
 * wild depending on install age, so we take the first file that exists.
 */
export function copilotConfigDirCandidates(
  configDir: string | undefined,
  homedir: string = NodeOS.homedir(),
): ReadonlyArray<string> {
  const explicit = asNonEmptyString(configDir);
  if (explicit) {
    return [explicit];
  }
  return [NodePath.join(homedir, ".config", "copilot"), NodePath.join(homedir, ".copilot")];
}

export async function loadCopilotMcpServers(
  configDir: string | undefined,
): Promise<Record<string, MCPServerConfig> | undefined> {
  for (const baseDir of copilotConfigDirCandidates(configDir)) {
    const configPath = NodePath.join(baseDir, "mcp-config.json");

    let raw: string;
    try {
      raw = await NodeFSP.readFile(configPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const parsed = asRecord(JSON.parse(raw));
    // Accept both the `{ mcpServers: {...} }` envelope and a bare map, which
    // older CLI versions wrote.
    const servers = asRecord(parsed?.mcpServers) ?? parsed;
    if (!servers) {
      return undefined;
    }

    const normalizedEntries = Object.entries(servers).flatMap(([name, value]) => {
      const normalized = toMcpServerConfig(value);
      return normalized ? [[name, normalized] as const] : [];
    });

    return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
  }

  return undefined;
}
