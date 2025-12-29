alter table "public"."tournament_stages" add column if not exists "match_options_id" uuid
 null;
