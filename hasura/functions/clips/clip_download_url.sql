-- Mirrors public.demo_download_url(match_map_demos) — same shape, same
-- settings key, just keyed off match_clips.file. The url is computed
-- at read time so it transparently follows whatever
-- settings.cloudflare_worker_url currently points at; users don't
-- need a re-render when we move the worker.
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
