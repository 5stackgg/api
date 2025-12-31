alter table "public"."tournament_brackets" drop constraint "tournament_brackets_match_options_id_fkey";
alter table "public"."tournament_stages" drop constraint "tournament_stages_match_options_id_fkey";

alter table "public"."tournament_brackets" drop column "match_options_id";
