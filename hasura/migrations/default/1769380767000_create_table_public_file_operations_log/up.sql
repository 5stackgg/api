CREATE TABLE IF NOT EXISTS "public"."file_operations_log" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "node_id" varchar NOT NULL,
  "server_id" uuid NULL,
  "operation" varchar NOT NULL,
  "path" varchar NOT NULL,
  "details" jsonb NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("node_id") REFERENCES "public"."game_server_nodes"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_file_operations_node_server" ON "public"."file_operations_log" USING btree ("node_id", "server_id", "created_at" DESC);