// @effect-diagnostics nodeBuiltinImport:off - resolves a binary path on disk
// before any Effect runtime exists; the SDK wants a plain string.
/**
 * Locate the GitHub Copilot CLI binary the SDK should drive.
 *
 * `@github/copilot` ships the actual binary in a per-platform optional
 * dependency (`@github/copilot-<platform>-<arch>`) plus an `npm-loader.js`
 * shim. The SDK can find it on its own when the process runs from a normal
 * `node_modules` tree, but the packaged desktop app runs from inside
 * `app.asar`, where module resolution does not reach the unpacked binary.
 * So we resolve it ourselves and hand the SDK an explicit `cliPath`.
 *
 * @module provider/Layers/copilotCliPath
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const CURRENT_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const GITHUB_SCOPE_DIR = "@github";
const COPILOT_PATHLESS_COMMAND_PATTERN = /^copilot(?:\.(?:exe|cmd|bat))?$/i;
const COPILOT_NPM_LOADER = "npm-loader.js";

function dedupePaths(paths: ReadonlyArray<string | undefined>): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    resolved.push(candidate);
  }

  return resolved;
}

function resolveSdkEntrypoint(): string | undefined {
  try {
    return require.resolve("@github/copilot-sdk");
  } catch {
    return undefined;
  }
}

function resolveProcessResourcesPath(): string | undefined {
  const processWithResourcesPath = process as NodeJS.Process & {
    readonly resourcesPath?: string;
  };
  return processWithResourcesPath.resourcesPath;
}

/**
 * A bare `copilot` (the settings default) means "let the SDK find it".
 * Returning `undefined` for that case keeps the bundled-path fallback in
 * play; only a real path counts as a deliberate override.
 */
export function normalizeCopilotCliPathOverride(
  value: string | null | undefined,
): string | undefined {
  if (value == null) return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    COPILOT_PATHLESS_COMMAND_PATTERN.test(trimmed)
  ) {
    return undefined;
  }

  return trimmed;
}

function resolveGithubScopeDirFromSdkEntrypoint(
  sdkEntrypoint: string | undefined,
): string | undefined {
  if (!sdkEntrypoint) return undefined;
  return NodePath.join(NodePath.dirname(NodePath.dirname(sdkEntrypoint)), "..");
}

function resolveNodeModulesRoots(input: {
  currentDir: string;
  resourcesPath?: string;
  sdkEntrypoint?: string;
}): string[] {
  const githubScopeDir = resolveGithubScopeDirFromSdkEntrypoint(input.sdkEntrypoint);
  return dedupePaths([
    input.resourcesPath
      ? NodePath.join(input.resourcesPath, "app.asar.unpacked/node_modules")
      : undefined,
    input.resourcesPath ? NodePath.join(input.resourcesPath, "node_modules") : undefined,
    NodePath.join(input.currentDir, "../../../node_modules"),
    NodePath.join(input.currentDir, "../../../../../node_modules"),
    githubScopeDir ? NodePath.join(githubScopeDir, "..") : undefined,
  ]);
}

function getCopilotPlatformBinaryName(platform: string): string {
  return platform === "win32" ? "copilot.exe" : "copilot";
}

export function getBundledCopilotPlatformPackages(
  platform: string,
  arch: string,
): ReadonlyArray<string> {
  if (platform === "darwin" && arch === "arm64") return ["copilot-darwin-arm64"];
  if (platform === "darwin" && arch === "x64") return ["copilot-darwin-x64"];
  if (platform === "linux" && arch === "arm64") return ["copilot-linux-arm64"];
  if (platform === "linux" && arch === "x64") return ["copilot-linux-x64"];
  if (platform === "win32" && arch === "arm64") return ["copilot-win32-arm64"];
  if (platform === "win32" && arch === "x64") return ["copilot-win32-x64"];
  return [];
}

/** Injectable core so the resolution order can be unit-tested per platform. */
export function resolveBundledCopilotCliPathFrom(input: {
  currentDir: string;
  platform: string;
  arch: string;
  resourcesPath?: string;
  sdkEntrypoint?: string;
  exists?: (path: string) => boolean;
}): string | undefined {
  const { platform, arch } = input;
  const exists = input.exists ?? NodeFS.existsSync;
  const sdkEntrypoint = input.sdkEntrypoint;
  const nodeModulesRoots = resolveNodeModulesRoots({
    currentDir: input.currentDir,
    ...(input.resourcesPath ? { resourcesPath: input.resourcesPath } : {}),
    ...(sdkEntrypoint ? { sdkEntrypoint } : {}),
  });
  const binaryName = getCopilotPlatformBinaryName(platform);
  const platformPackages = getBundledCopilotPlatformPackages(platform, arch);

  // Prefer the real binary over the loader shim — spawning the shim costs an
  // extra Node boot per session.
  const binaryCandidates = nodeModulesRoots.flatMap((root) =>
    platformPackages.map((packageName) =>
      NodePath.join(root, GITHUB_SCOPE_DIR, packageName, binaryName),
    ),
  );
  const npmLoaderCandidates = nodeModulesRoots.map((root) =>
    NodePath.join(root, GITHUB_SCOPE_DIR, "copilot", COPILOT_NPM_LOADER),
  );
  for (const candidate of dedupePaths([...binaryCandidates, ...npmLoaderCandidates])) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  // pnpm's isolated store puts the platform package next to the SDK rather
  // than under a shared `node_modules` root, so check there last.
  const githubScopeDir = resolveGithubScopeDirFromSdkEntrypoint(sdkEntrypoint);
  if (!githubScopeDir) {
    return undefined;
  }

  const sdkSiblingBinaryCandidates = platformPackages.map((packageName) =>
    NodePath.join(githubScopeDir, packageName, binaryName),
  );
  const sdkSiblingLoaderPath = NodePath.join(githubScopeDir, "copilot", COPILOT_NPM_LOADER);
  for (const candidate of dedupePaths([...sdkSiblingBinaryCandidates, sdkSiblingLoaderPath])) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Platform and arch are passed in (rather than read from the host here) so
 * the only place that touches the real runtime is the shared
 * `HostProcess*` references — see `makeCopilotClientOptions`.
 */
export function resolveBundledCopilotCliPath(host: {
  readonly platform: string;
  readonly arch: string;
}): string | undefined {
  const sdkEntrypoint = resolveSdkEntrypoint();
  const resourcesPath = resolveProcessResourcesPath();
  return resolveBundledCopilotCliPathFrom({
    currentDir: CURRENT_DIR,
    platform: host.platform,
    arch: host.arch,
    ...(resourcesPath ? { resourcesPath } : {}),
    ...(sdkEntrypoint ? { sdkEntrypoint } : {}),
  });
}
