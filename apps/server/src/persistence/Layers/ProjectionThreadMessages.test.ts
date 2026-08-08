import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("getLatestUserMessageAt returns null when a thread has no user messages", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-none");

      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-none-1"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "assistant only",
        isStreaming: false,
        createdAt: "2026-02-28T19:20:00.000Z",
        updatedAt: "2026-02-28T19:20:00.000Z",
      });

      assert.equal(yield* repository.getLatestUserMessageAt({ threadId }), null);
    }),
  );

  it.effect("getLatestUserMessageAt returns the newest user message timestamp", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-newest");
      const otherThreadId = ThreadId.make("thread-latest-user-other");

      const upsertMessage = (
        messageId: string,
        thread: typeof threadId,
        role: "user" | "assistant",
        createdAt: string,
      ) =>
        repository.upsert({
          messageId: MessageId.make(messageId),
          threadId: thread,
          turnId: null,
          role,
          text: messageId,
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
        });

      // Inserted out of order so the assertion depends on MAX, not insert order.
      yield* upsertMessage("m-2", threadId, "user", "2026-02-28T19:30:02.000Z");
      yield* upsertMessage("m-1", threadId, "user", "2026-02-28T19:30:01.000Z");
      // A newer assistant message must not win.
      yield* upsertMessage("m-3", threadId, "assistant", "2026-02-28T19:30:09.000Z");
      // A newer user message on another thread must not leak in.
      yield* upsertMessage("m-4", otherThreadId, "user", "2026-02-28T19:30:59.000Z");

      assert.equal(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-02-28T19:30:02.000Z",
      );
    }),
  );
});
