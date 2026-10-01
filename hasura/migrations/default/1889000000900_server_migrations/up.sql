CREATE TABLE IF NOT EXISTS "public"."e_server_migration_statuses" (
    "value" text NOT NULL,
    "description" text NOT NULL,
    PRIMARY KEY ("value")
);

CREATE TABLE IF NOT EXISTS "public"."server_migrations" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "server_id" uuid NOT NULL,
    "from_game_server_node_id" text,
    "to_game_server_node_id" text,
    "status" text NOT NULL DEFAULT 'Queued',
    "with_files" boolean NOT NULL DEFAULT true,
    "bytes_total" bigint,
    "bytes_done" bigint NOT NULL DEFAULT 0,
    "entries_total" integer,
    "error" text,
    "warnings" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "requested_by_steam_id" bigint,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "started_at" timestamptz,
    "finished_at" timestamptz,
    PRIMARY KEY ("id"),
    CONSTRAINT "server_migrations_server_id_fkey" FOREIGN KEY ("server_id")
        REFERENCES "public"."servers" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "server_migrations_from_game_server_node_id_fkey" FOREIGN KEY ("from_game_server_node_id")
        REFERENCES "public"."game_server_nodes" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "server_migrations_to_game_server_node_id_fkey" FOREIGN KEY ("to_game_server_node_id")
        REFERENCES "public"."game_server_nodes" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "server_migrations_status_fkey" FOREIGN KEY ("status")
        REFERENCES "public"."e_server_migration_statuses" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "server_migrations_requested_by_steam_id_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "server_migrations_one_active_idx"
    ON "public"."server_migrations" ("server_id")
    WHERE "status" IN ('Queued', 'Stopping', 'Transferring', 'Finalizing');

CREATE INDEX IF NOT EXISTS "server_migrations_server_created_idx"
    ON "public"."server_migrations" ("server_id", "created_at" DESC);
