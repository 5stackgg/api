alter table "public"."match_map_rounds" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_kills" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_assists" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_damages" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_flashes" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_utility" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_objectives" add column if not exists "deleted_at" timestamptz null;

alter table "public"."player_unused_utility" add column if not exists "deleted_at" timestamptz null;