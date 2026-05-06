CREATE OR REPLACE FUNCTION public.clip_download_url(match_clips public.match_clips)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        demos_domain text;
        slug text;
        basename text;
        download_name text;
    BEGIN
        IF match_clips.file IS NULL THEN
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

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/', match_clips.file, '?name=', download_name);
        END IF;

        SELECT value INTO demos_domain
        FROM settings
        WHERE name = 'demos_domain';

        IF demos_domain IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(demos_domain, '/clips/', match_clips.id, '?name=', download_name);
    END;
$$;
