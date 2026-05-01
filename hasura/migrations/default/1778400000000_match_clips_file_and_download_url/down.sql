drop function if exists public.clip_download_url(public.match_clips);

alter table "public"."match_clips"
  add column if not exists "s3_url" text;

-- Best-effort restore. Rows whose `file` was populated only by the
-- backfill above will reconstruct against the current
-- settings.cloudflare_worker_url. Anything that was null stays null.
update "public"."match_clips" mc
   set "s3_url" = case
     when mc."file" is null then null
     else CONCAT(
       (select value from settings where name = 'cloudflare_worker_url'),
       '/clips?file=', mc."file"
     )
   end;

alter table "public"."match_clips"
  drop column if exists "file";
