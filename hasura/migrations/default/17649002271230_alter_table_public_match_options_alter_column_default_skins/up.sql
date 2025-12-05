alter table "public"."match_options" drop column if exists "default_skins";
alter table "public"."match_options" drop column if exists "default_models";
alter table "public"."match_options" add column if not exists "default_models" boolean default false;
