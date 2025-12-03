alter table "public"."tournament_brackets" add column if not exists "finished" boolean
 not null default 'false';
