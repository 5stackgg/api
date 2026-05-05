-- Mirrors public.demo_download_url(match_map_demos) — same shape, same
-- settings key, just keyed off match_clips.file. The url is computed
-- at read time so it transparently follows whatever
-- settings.cloudflare_worker_url currently points at; users don't
-- need a re-render when we move the worker.
--
-- URL shape: path-style + ?name=<slugified-title>.mp4
--   - Path-style means the URL ends in the real S3 key
--     (".../clips/<user>/<jobId>.mp4") instead of the previous
--     "/clips?file=..." which made browsers suggest "clips" as the
--     download filename. Now they at least see "<jobId>.mp4".
--   - The `?name=` query is consumed by the cloudflare-workers/
--     backblaze-proxy worker and used to set Content-Disposition
--     filename, so a human-friendly title overrides the UUID for
--     both inline saves and the explicit Download button. Falls
--     back to the jobId basename when no title was set.
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

        -- Slugify the title: collapse anything that isn't a letter,
        -- digit, hyphen, or underscore into "-", trim leading /
        -- trailing dashes, cap to a sane length so URL doesn't
        -- balloon for long titles.
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

        -- The basename of the s3 key — "<jobId>.mp4" — is the safe
        -- fallback. Always end the suggested name in .mp4 so the
        -- recipient's OS picks the right opener.
        basename := regexp_replace(match_clips.file, '^.*/', '');
        IF slug IS NOT NULL THEN
            download_name := slug || '.mp4';
        ELSE
            download_name := basename;
        END IF;

        RETURN CONCAT(worker_url, '/', match_clips.file, '?name=', download_name);
    END;
$$;
