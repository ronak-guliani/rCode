// @effect-diagnostics nodeBuiltinImport:off - builds expected paths with the
// same separator rules as the code under test.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  getBundledCopilotPlatformPackages,
  normalizeCopilotCliPathOverride,
  resolveBundledCopilotCliPathFrom,
} from "./copilotCliPath.ts";

describe("normalizeCopilotCliPathOverride", () => {
  it.each([undefined, null, "", "   "])("treats %j as no override", (value) => {
    expect(normalizeCopilotCliPathOverride(value)).toBeUndefined();
  });

  it.each(["copilot", "copilot.exe", "COPILOT.CMD", "copilot.bat"])(
    "treats the bare command %j as no override so the bundled binary wins",
    (value) => {
      expect(normalizeCopilotCliPathOverride(value)).toBeUndefined();
    },
  );

  it.each(["/usr/local/bin/copilot", "C:\\tools\\copilot.exe", "./copilot"])(
    "keeps a real path like %j",
    (value) => {
      expect(normalizeCopilotCliPathOverride(value)).toBe(value);
    },
  );

  it("trims surrounding whitespace", () => {
    expect(normalizeCopilotCliPathOverride("  /opt/copilot  ")).toBe("/opt/copilot");
  });
});

describe("getBundledCopilotPlatformPackages", () => {
  it.each([
    ["darwin", "arm64", "copilot-darwin-arm64"],
    ["darwin", "x64", "copilot-darwin-x64"],
    ["linux", "arm64", "copilot-linux-arm64"],
    ["linux", "x64", "copilot-linux-x64"],
    ["win32", "arm64", "copilot-win32-arm64"],
    ["win32", "x64", "copilot-win32-x64"],
  ])("maps %s/%s to %s", (platform, arch, expected) => {
    expect(getBundledCopilotPlatformPackages(platform, arch)).toEqual([expected]);
  });

  it("returns nothing for a platform GitHub does not ship", () => {
    expect(getBundledCopilotPlatformPackages("aix", "ppc64")).toEqual([]);
  });
});

describe("resolveBundledCopilotCliPathFrom", () => {
  // Five levels up from the Layers dir is the workspace root, matching how
  // this module sits in the built output.
  const currentDir = NodePath.join("/app", "apps", "server", "src", "provider", "Layers");
  const workspaceNodeModules = NodePath.join("/app", "node_modules");
  const baseInput = { currentDir, platform: "linux", arch: "x64" } as const;

  it("returns undefined when nothing exists and the SDK cannot be located", () => {
    expect(resolveBundledCopilotCliPathFrom({ ...baseInput, exists: () => false })).toBeUndefined();
  });

  it("prefers the unpacked binary inside a packaged desktop app", () => {
    const resourcesPath = NodePath.join("/Applications", "T3.app", "Contents", "Resources");
    const expected = NodePath.join(
      resourcesPath,
      "app.asar.unpacked/node_modules",
      "@github",
      "copilot-linux-x64",
      "copilot",
    );

    expect(
      resolveBundledCopilotCliPathFrom({
        ...baseInput,
        resourcesPath,
        exists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("prefers the real binary over the npm loader shim", () => {
    const binary = NodePath.join(workspaceNodeModules, "@github", "copilot-linux-x64", "copilot");
    const loader = NodePath.join(workspaceNodeModules, "@github", "copilot", "npm-loader.js");

    expect(
      resolveBundledCopilotCliPathFrom({
        ...baseInput,
        exists: (candidate) => candidate === binary || candidate === loader,
      }),
    ).toBe(binary);
  });

  it("falls back to the npm loader when no platform binary is present", () => {
    const loader = NodePath.join(workspaceNodeModules, "@github", "copilot", "npm-loader.js");
    expect(
      resolveBundledCopilotCliPathFrom({
        ...baseInput,
        exists: (candidate) => candidate === loader,
      }),
    ).toBe(loader);
  });

  it("finds the platform package next to the SDK in a pnpm store", () => {
    // require.resolve("@github/copilot-sdk") lands on the package's dist entry;
    // the platform package is a sibling of the SDK inside the @github scope.
    const scopeDir = NodePath.join("/store", "node_modules", "@github");
    const sdkEntrypoint = NodePath.join(scopeDir, "copilot-sdk", "dist", "index.js");
    const expected = NodePath.join(scopeDir, "copilot-linux-x64", "copilot");

    expect(
      resolveBundledCopilotCliPathFrom({
        ...baseInput,
        sdkEntrypoint,
        exists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("uses the requested platform, not the host's", () => {
    const expected = NodePath.join(
      workspaceNodeModules,
      "@github",
      "copilot-win32-x64",
      "copilot.exe",
    );
    expect(
      resolveBundledCopilotCliPathFrom({
        ...baseInput,
        platform: "win32",
        exists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });
});
