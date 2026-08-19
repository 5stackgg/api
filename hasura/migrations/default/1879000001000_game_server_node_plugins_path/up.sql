-- Where the node says the plugin's files actually are, relative to its
-- custom-plugins root. The catalog cannot know this for a csgo-layout release,
-- and guessing sent operators to a configs directory that may never exist.
alter table "public"."game_server_node_plugins" add column if not exists "path" text null;
