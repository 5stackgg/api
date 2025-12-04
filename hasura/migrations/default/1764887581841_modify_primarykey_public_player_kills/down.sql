alter table "public"."player_kills" alter column "id" set default gen_random_uuid();
alter table "public"."player_kills" alter column "id" drop not null;
alter table "public"."player_kills" add column "id" uuid;

alter table "public"."player_kills" drop constraint "player_kills_pkey";
alter table "public"."player_kills"
    add constraint "player_kills_pkey"
    primary key ("match_id", "id", "match_map_id", "time");
