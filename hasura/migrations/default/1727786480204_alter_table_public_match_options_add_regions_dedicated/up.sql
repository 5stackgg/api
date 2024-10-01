alter table "public"."match_options" add column if not exists "regions" text[]
 null default '{}';

alter table "public"."match_options" add column if not exists "prefer_dedicated_server" boolean
 not null default 'false';
