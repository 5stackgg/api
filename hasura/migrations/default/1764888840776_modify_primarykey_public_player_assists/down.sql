alter table "public"."player_assists" alter column "id" set default gen_random_uuid();
alter table "public"."player_assists" alter column "id" drop not null;
alter table "public"."player_assists" add column "id" uuid;

alter table "public"."player_assists" drop constraint "player_assists_pkey";
alter table "public"."player_assists"
    add constraint "player_assists_pkey"
    primary key ("time", "id", "match_map_id");
