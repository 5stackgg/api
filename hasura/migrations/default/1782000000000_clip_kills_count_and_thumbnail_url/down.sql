drop function if exists public.clip_thumbnail_download_url(public.match_clips);

drop index if exists "public"."match_clips_kills_count_idx";

alter table "public"."match_clips"
  drop column if exists "kills_count";
