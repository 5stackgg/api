alter table "public"."match_options" add column if not exists "tv_delay" Integer
 not null default '115';
