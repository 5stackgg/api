alter table "public"."match_map_demos"
  drop column if exists "players";

drop function if exists public.clip_download_url(public.match_clips);

drop table if exists "public"."clip_render_jobs";
drop table if exists "public"."match_clips";
