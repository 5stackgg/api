alter table "public"."match_options" add column if not exists "default_skins" boolean
 not null default 'false';
