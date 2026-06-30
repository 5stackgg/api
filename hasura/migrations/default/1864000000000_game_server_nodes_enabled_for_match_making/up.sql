alter table "public"."game_server_nodes"
  add column if not exists "enabled_for_match_making" boolean not null default true;
