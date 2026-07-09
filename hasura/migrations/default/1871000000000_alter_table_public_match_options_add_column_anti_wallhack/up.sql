alter table "public"."match_options"
  add column if not exists "anti_wallhack" boolean not null default true;
