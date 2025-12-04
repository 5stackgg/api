alter table "public"."player_flashes" alter column "id" set default gen_random_uuid();
alter table "public"."player_flashes" alter column "id" drop not null;
alter table "public"."player_flashes" add column "id" uuid;

alter table "public"."player_flashes" drop constraint "player_flashes_pkey";
alter table "public"."player_flashes"
    add constraint "player_flashes_pkey"
    primary key ("match_id", "time", "id", "match_map_id");
