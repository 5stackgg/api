alter table "public"."match_maps"
  add column if not exists "anti_wallhack_active" boolean null;
