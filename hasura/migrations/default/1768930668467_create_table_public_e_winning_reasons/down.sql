alter table "public"."match_map_rounds" drop column if exists "winning_reason";

DROP TABLE "public"."e_winning_reasons";

alter table "public"."match_map_rounds" drop constraint "match_map_rounds_winning_reason_fkey";
