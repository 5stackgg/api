ALTER TABLE "public"."game_server_nodes" ADD COLUMN IF NOT EXISTS "disk_available_gb" integer;
ALTER TABLE "public"."game_server_nodes" ADD COLUMN IF NOT EXISTS "disk_used_percent" integer;
