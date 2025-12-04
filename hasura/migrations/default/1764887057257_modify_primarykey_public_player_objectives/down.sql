alter table "public"."player_objectives" alter column "id" set default gen_random_uuid();
alter table "public"."player_objectives" alter column "id" drop not null;
alter table "public"."player_objectives" add column "id" uuid;

alter table "public"."player_objectives" drop constraint "player_objectives_pkey";
alter table "public"."player_objectives"
    add constraint "player_objectives_pkey"
    primary key ("match_id", "time", "match_map_id", "id");
