alter table "public"."player_unused_utility" alter column "id" set default gen_random_uuid();
alter table "public"."player_unused_utility" alter column "id" drop not null;
alter table "public"."player_unused_utility" add column "id" uuid;


alter table "public"."player_unused_utility" drop constraint "player_unused_utility_pkey";
alter table "public"."player_unused_utility"
    add constraint "player_unused_utility_pkey"
    primary key ("id");

