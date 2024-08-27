alter table "public"."match_options" drop column "region_veto";
alter table "public"."match_map_veto_picks" rename to "match_veto_picks";

DROP TABLE "public"."match_region_veto_picks";

alter table "public"."matches" drop constraint "matches_region_fkey";
alter table "public"."matches" drop column "region";
