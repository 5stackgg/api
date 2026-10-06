alter table "public"."server_regions" add column if not exists "steam_relay" boolean
 not null default 'false';
