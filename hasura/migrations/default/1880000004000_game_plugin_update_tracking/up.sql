-- An Auto channel install changes version with nobody asking it to, and the row
-- only ever held where it landed. Without the version it came from there is no
-- record that anything moved -- the API overwrites `version` the moment a node
-- reports Installing, so the old value is gone before the install finishes.
ALTER TABLE "public"."game_server_node_plugins"
    ADD COLUMN IF NOT EXISTS "previous_version" text;
