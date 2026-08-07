import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  LAST_IN_TREE_CONTIGUOUS_MIGRATION_ID,
  SHARED_UPSTREAM_MIGRATION_ID_CEILING,
  assertMigrationIdPolicy,
  migrationManifest,
  runMigrations,
} from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("067_068_SharedUpstreamWatermark", (it) => {
  it("rejects fork-only migration ids that sit under the upstream ceiling", () => {
    assert.throws(
      () =>
        assertMigrationIdPolicy([
          [LAST_IN_TREE_CONTIGUOUS_MIGRATION_ID, "ProjectionThreadsPinned"],
          // Historical footgun: rCode shipped these as 37/38 while shared
          // userdata already carried upstream ids through 66.
          [LAST_IN_TREE_CONTIGUOUS_MIGRATION_ID + 1, "ProjectionTurnsKeysetIndex"],
          [LAST_IN_TREE_CONTIGUOUS_MIGRATION_ID + 2, "ProjectionThreadsPinOrderKey"],
        ]),
      /upstream-reserved range/,
    );
  });

  it("accepts the live manifest and keeps fork-only ids above the ceiling", () => {
    assertMigrationIdPolicy(migrationManifest);

    const forkOnlyIds = migrationManifest
      .map(([id]) => id)
      .filter((id) => id > LAST_IN_TREE_CONTIGUOUS_MIGRATION_ID);

    assert.ok(forkOnlyIds.length > 0);
    for (const id of forkOnlyIds) {
      assert.ok(
        id > SHARED_UPSTREAM_MIGRATION_ID_CEILING,
        `fork-only migration ${id} must be > ${SHARED_UPSTREAM_MIGRATION_ID_CEILING}`,
      );
    }
  });

  it.effect(
    "applies fork-only migrations when shared userdata is already at the upstream watermark",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Shared base schema as this tree ships it.
        yield* runMigrations({ toMigrationInclusive: LAST_IN_TREE_CONTIGUOUS_MIGRATION_ID });

        // Simulate a machine that also runs upstream T3 Code: Effect only
        // stores the latest applied id, so a single high watermark is enough
        // to reproduce the skip-everything-below-latest failure mode.
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (
            ${SHARED_UPSTREAM_MIGRATION_ID_CEILING},
            ${"UpstreamSharedWatermark"}
          )
        `;

        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed.map(([id, name]) => [id, name]),
          [
            [67, "ProjectionTurnsKeysetIndex"],
            [68, "ProjectionThreadsPinOrderKey"],
          ],
        );

        const recorded = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`
          SELECT migration_id, name
          FROM effect_sql_migrations
          WHERE migration_id IN (67, 68)
          ORDER BY migration_id
        `;
        assert.deepStrictEqual(recorded, [
          { migration_id: 67, name: "ProjectionTurnsKeysetIndex" },
          { migration_id: 68, name: "ProjectionThreadsPinOrderKey" },
        ]);

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.ok(columns.some((column) => column.name === "pin_order_key"));

        const indexes = yield* sql<{ readonly name: string }>`
          PRAGMA index_list(projection_turns)
        `;
        assert.ok(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));

        // Second pass must stay a no-op once fork-only ids are recorded above
        // the upstream watermark (idempotent relaunch path).
        const secondPass = yield* runMigrations();
        assert.deepStrictEqual(secondPass, []);
      }),
  );
});
