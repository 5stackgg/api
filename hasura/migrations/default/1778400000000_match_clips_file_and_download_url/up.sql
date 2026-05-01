-- Add the storage-key column + clip_download_url SQL function so
-- match_clips serves through the same cloudflare worker pattern as
-- match_map_demos (worker reads `?file=` and signs the upstream
-- backblaze GET, so egress comes off cloudflare's free network).

alter table "public"."match_clips"
  add column if not exists "file" text;

-- Existing rows had a full URL in s3_url (e.g.
-- `https://demos.5stack.gg/clips/<user>/<id>.mp4`). Backfill `file`
-- by extracting the storage-key suffix that sits after the host. Rows
-- whose s3_url is null stay null — clip_download_url returns null in
-- that case and the web hides the download/play actions for the row.
update "public"."match_clips"
   set "file" = regexp_replace("s3_url", '^https?://[^/]+/', '')
 where "file" is null
   and "s3_url" is not null;

-- s3_url is now redundant — clients should read the `download_url`
-- computed field instead. Drop it so we don't have two truths.
alter table "public"."match_clips"
  drop column if exists "s3_url";

CREATE OR REPLACE FUNCTION public.clip_download_url(match_clips public.match_clips)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
    BEGIN
        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL AND match_clips.file IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/clips?file=', match_clips.file);
        END IF;

        RETURN NULL;
    END;
$$;
