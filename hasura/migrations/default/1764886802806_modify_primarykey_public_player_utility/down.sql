alter table "public"."player_utility" alter column "id" set default gen_random_uuid();
alter table "public"."player_utility" alter column "id" drop not null;
alter table "public"."player_utility" add column "id" uuid;

alter table "public"."player_utility" drop constraint "player_utility_pkey";

alter table "public"."player_utility"
    add constraint "player_utility_pkey"
    primary key ("match_id", "attacker_steam_id", "time");
