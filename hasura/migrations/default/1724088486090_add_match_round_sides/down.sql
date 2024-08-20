alter table "public"."match_map_rounds" drop constraint "match_map_rounds_lineup_1_side_fkey";
alter table "public"."match_map_rounds" drop constraint "match_map_rounds_lineup_2_side_fkey";

alter table "public"."match_map_rounds" drop column "lineup_1_side";
alter table "public"."match_map_rounds" drop column "lineup_2_side";
