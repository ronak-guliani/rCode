import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("listUserInputActivitiesByThreadId returns only user-input signal kinds", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-user-input-signals");
      const otherThreadId = ThreadId.make("thread-user-input-other");

      const upsertActivity = (
        activityId: string,
        thread: typeof threadId,
        kind: string,
        sequence: number,
      ) =>
        repository.upsert({
          activityId: EventId.make(activityId),
          threadId: thread,
          turnId: null,
          tone: "info",
          kind,
          summary: activityId,
          payload: { requestId: `${activityId}-request` },
          sequence,
          createdAt: `2026-02-28T20:00:0${sequence}.000Z`,
        });

      yield* upsertActivity("a-1", threadId, "user-input.requested", 1);
      // Tool activities carry the largest payloads and must never be loaded here.
      yield* upsertActivity("a-2", threadId, "tool.call.completed", 2);
      yield* upsertActivity("a-3", threadId, "user-input.resolved", 3);
      yield* upsertActivity("a-4", threadId, "provider.user-input.respond.failed", 4);
      yield* upsertActivity("a-5", otherThreadId, "user-input.requested", 5);

      const rows = yield* repository.listUserInputActivitiesByThreadId({ threadId });

      assert.deepEqual(
        rows.map((row) => row.kind),
        ["user-input.requested", "user-input.resolved", "provider.user-input.respond.failed"],
      );
    }),
  );

  it.effect("listUserInputActivitiesByThreadId orders rows like listByThreadId", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-user-input-ordering");

      const upsertActivity = (activityId: string, sequence: number | null, createdAt: string) =>
        repository.upsert({
          activityId: EventId.make(activityId),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.requested",
          summary: activityId,
          payload: { requestId: `${activityId}-request` },
          ...(sequence === null ? {} : { sequence }),
          createdAt,
        });

      yield* upsertActivity("b-3", 2, "2026-02-28T20:10:03.000Z");
      yield* upsertActivity("b-1", null, "2026-02-28T20:10:01.000Z");
      yield* upsertActivity("b-2", 1, "2026-02-28T20:10:02.000Z");

      const filtered = yield* repository.listUserInputActivitiesByThreadId({ threadId });
      const all = yield* repository.listByThreadId({ threadId });

      assert.deepEqual(
        filtered.map((row) => row.activityId),
        all.map((row) => row.activityId),
      );
      assert.deepEqual(
        filtered.map((row) => row.activityId),
        ["b-1", "b-2", "b-3"],
      );
    }),
  );
});
