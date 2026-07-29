/**
 * Commit / PR / branch / title generation backed by the GitHub Copilot CLI.
 *
 * Each call spins up a short-lived headless Copilot session, sends one prompt,
 * concatenates the streamed assistant text, and tears the session down. The
 * session denies every permission request outright: these prompts only need
 * the model to write text, so any attempt to run a command or touch a file is
 * a prompt-injection risk from diff content, not legitimate work.
 *
 * @module textGeneration/CopilotTextGeneration
 */
import { CopilotClient } from "@github/copilot-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type CopilotSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { makeCopilotClientOptions } from "../provider/Layers/CopilotProvider.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const COPILOT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export function makeCopilotTextGeneration(
  copilotSettings: CopilotSettings,
): TextGeneration.TextGeneration["Service"] {
  /**
   * Run one prompt to completion and return the assistant's raw text.
   *
   * Copilot streams `assistant.message_delta` and then repeats the whole
   * message in `assistant.message`, so we accumulate deltas and let the
   * final message overwrite them — that avoids duplicated text while still
   * producing output if only one of the two arrives.
   */
  const runCopilotPrompt = (input: {
    readonly operation: TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string | undefined;
  }): Effect.Effect<string, TextGenerationError> =>
    Effect.flatMap(makeCopilotClientOptions(copilotSettings, { cwd: input.cwd }), (clientOptions) =>
      Effect.tryPromise({
        try: async () => {
          const client = new CopilotClient(clientOptions);
          let streamed = "";
          let finalMessage: string | undefined;

          try {
            await client.start();
            const session = await client.createSession({
              ...(input.model ? { model: input.model } : {}),
              ...(copilotSettings.homePath.trim()
                ? { configDir: copilotSettings.homePath.trim() }
                : {}),
              workingDirectory: input.cwd,
              streaming: true,
              onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }) as const,
            });

            const unsubscribe = session.on((event) => {
              if (event.type === "assistant.message_delta") {
                streamed += event.data.deltaContent;
                return;
              }
              if (event.type === "assistant.message") {
                finalMessage = event.data.content;
              }
            });

            try {
              await session.send({ prompt: input.prompt, mode: "immediate" });
            } finally {
              unsubscribe();
              await session.disconnect().catch(() => undefined);
            }
          } finally {
            await client.stop().catch(() => []);
          }

          return (finalMessage ?? streamed).trim();
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "GitHub Copilot text generation request failed.",
            cause,
          }),
      }).pipe(
        Effect.timeoutOption(COPILOT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "GitHub Copilot text generation request timed out.",
                }),
              ),
            onSome: (value: string) => Effect.succeed(value),
          }),
        ),
      ),
    );

  const runCopilotJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const output = yield* runCopilotPrompt({
        operation,
        cwd,
        prompt,
        model: modelSelection.model,
      });

      if (!output) {
        return yield* new TextGenerationError({
          operation,
          detail: "GitHub Copilot returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "GitHub Copilot returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "GitHub Copilot text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CopilotTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCopilotJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CopilotTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCopilotJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CopilotTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCopilotJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CopilotTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCopilotJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
}
