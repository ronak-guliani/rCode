import { describe, expect, it } from "@effect/vitest";
import { CopilotSettings, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("CopilotTextGeneration", () => {
  it.effect("waits for session completion before disconnecting", () => {
    const calls: string[] = [];
    let sessionConfig: SessionConfig | undefined;
    const session = {
      on: () => () => {
        calls.push("unsubscribe");
      },
      send: async () => {
        throw new Error("send must not be used for completion-aware generation");
      },
      sendAndWait: async () => {
        calls.push("sendAndWait");
        return {
          type: "assistant.message",
          data: { content: JSON.stringify({ title: "Wait for Copilot completion" }) },
        };
      },
      disconnect: async () => {
        calls.push("disconnect");
      },
    } as unknown as Awaited<ReturnType<CopilotClient["createSession"]>>;
    const client = {
      start: async () => {
        calls.push("start");
      },
      createSession: async (config: SessionConfig) => {
        sessionConfig = config;
        calls.push("createSession");
        return session;
      },
      stop: async () => {
        calls.push("stop");
        return [];
      },
    } as unknown as Pick<CopilotClient, "start" | "createSession" | "stop">;
    const textGeneration = makeCopilotTextGeneration(
      decodeCopilotSettings({ homePath: "/tmp/copilot-home" }),
      { GH_TOKEN: "instance-token" },
      { clientFactory: () => client },
    );

    return Effect.gen(function* () {
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: "/tmp/worktree",
        message: "Fix generation completion.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("copilot"),
          model: "gpt-5-mini",
        },
      });

      expect(generated.title).toBe("Wait for Copilot completion");
      expect(sessionConfig?.configDirectory).toBe("/tmp/copilot-home");
      expect(calls).toEqual([
        "start",
        "createSession",
        "sendAndWait",
        "unsubscribe",
        "disconnect",
        "stop",
      ]);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessArchitecture, "arm64"),
    );
  });
});
