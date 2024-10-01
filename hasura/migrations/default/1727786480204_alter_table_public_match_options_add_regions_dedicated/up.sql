alter table "public"."match_options" add column if not exists "regions" json
 null default json_build_array();

alter table "public"."match_options" add column if not exists "prefer_dedicated_server" boolean
 not null default 'false';
