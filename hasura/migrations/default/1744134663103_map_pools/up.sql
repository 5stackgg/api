alter table "public"."maps" add column if not exists "enabled" boolean
 not null default 'true';