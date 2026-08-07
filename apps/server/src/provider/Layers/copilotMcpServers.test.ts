// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { copilotConfigDirCandidates, loadCopilotMcpServers } from "./copilotMcpServers.ts";

describe("copilotConfigDirCandidates", () => {
  it("expands a leading home-directory marker", () => {
    expect(copilotConfigDirCandidates("~/.copilot", "/Users/test")).toEqual([
      "/Users/test/.copilot",
    ]);
  });
});

describe("loadCopilotMcpServers", () => {
  it("preserves value whitespace and maps local cwd to the SDK field", async () => {
    const configDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-copilot-mcp-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(configDir, "mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            local: {
              command: "node",
              args: ["--eval", "  console.log('exact')  "],
              env: { EXACT: "  value  " },
              cwd: "/tmp/project",
            },
            remote: {
              type: "http",
              url: "https://example.test/mcp",
              headers: { Authorization: "Bearer token-with-space " },
            },
          },
        }),
      );

      const servers = await loadCopilotMcpServers(configDir);
      expect(servers?.local).toMatchObject({
        type: "local",
        args: ["--eval", "  console.log('exact')  "],
        env: { EXACT: "  value  " },
        workingDirectory: "/tmp/project",
      });
      expect(servers?.remote).toMatchObject({
        headers: { Authorization: "Bearer token-with-space " },
      });
    } finally {
      await NodeFSP.rm(configDir, { recursive: true, force: true });
    }
  });
});
