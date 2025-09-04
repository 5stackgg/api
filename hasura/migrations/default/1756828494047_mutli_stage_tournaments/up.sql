alter table "public"."tournament_teams" add column if not exists "created_at" timestamptz
 not null default now();

alter table "public"."tournament_stages" add column if not exists "groups" int default 1;

alter table "public"."tournament_brackets" add column if not exists "group" numeric
 null;

alter table "public"."tournament_brackets" add column if not exists "bye" boolean
 not null default 'false';

alter table "public"."tournament_brackets" add column if not exists "scheduled_eta" timestamptz
 null;
