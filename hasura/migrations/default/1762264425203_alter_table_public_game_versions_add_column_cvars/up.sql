alter table "public"."game_versions" add column if not exists "cvars" boolean
 not null default 'false';
