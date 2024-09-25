alter table "public"."match_options" add column if not exists"lan" boolean
 not null default 'false';
