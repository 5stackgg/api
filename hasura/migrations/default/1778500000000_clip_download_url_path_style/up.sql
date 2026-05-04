-- Rebuild clip_download_url to:
--   1. Use path-style URLs ("/clips/<user>/<jobId>.mp4") instead of
--      "?file=KEY". The previous shape made browsers suggest "clips"
--      as the download filename when a recipient saved a copied
--      share link.
--   2. Include a `?name=<slug>.mp4` query so the proxy worker can
--      set Content-Disposition filename to a human-readable title
--      (e.g. "Joe-Best-Round-3K.mp4") instead of the UUID.
--
-- Source of truth lives in api/hasura/functions/clips/clip_download_url.sql.

CREATE OR REPLACE FUNCTION public.clip_download_url(match_clips public.match_clips)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        slug text;
        basename text;
        download_name text;
    BEGIN
        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NULL OR match_clips.file IS NULL THEN
            RETURN NULL;
        END IF;

        slug := NULL;
        IF match_clips.title IS NOT NULL AND length(trim(match_clips.title)) > 0 THEN
            slug := regexp_replace(trim(match_clips.title), '[^a-zA-Z0-9_-]+', '-', 'g');
            slug := regexp_replace(slug, '^-+|-+$', '', 'g');
            IF length(slug) > 80 THEN
                slug := substring(slug from 1 for 80);
            END IF;
            IF length(slug) = 0 THEN
                slug := NULL;
            END IF;
        END IF;

        basename := regexp_replace(match_clips.file, '^.*/', '');
        IF slug IS NOT NULL THEN
            download_name := slug || '.mp4';
        ELSE
            download_name := basename;
        END IF;

        RETURN CONCAT(worker_url, '/', match_clips.file, '?name=', download_name);
    END;
$$;
