alter table "public"."tournament_brackets" add column if not exists "team_1_seed" integer
 null;

alter table "public"."tournament_brackets" add column if not exists "team_2_seed" integer
 null;
