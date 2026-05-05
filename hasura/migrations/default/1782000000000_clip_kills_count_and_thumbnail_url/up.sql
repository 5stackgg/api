alter table "public"."match_clips"
  add column if not exists "kills_count" integer;

create index if not exists "match_clips_kills_count_idx"
  on "public"."match_clips" ("kills_count" desc nulls last);

CREATE OR REPLACE FUNCTION public.clip_thumbnail_download_url(match_clips public.match_clips)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
    BEGIN
        IF match_clips.thumbnail_url IS NULL THEN
            RETURN NULL;
        END IF;

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(worker_url, '/', match_clips.thumbnail_url);
    END;
$$;
