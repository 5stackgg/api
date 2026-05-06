CREATE OR REPLACE FUNCTION public.clip_thumbnail_download_url(match_clips public.match_clips)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        demos_domain text;
    BEGIN
        IF match_clips.thumbnail_url IS NULL THEN
            RETURN NULL;
        END IF;

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/', match_clips.thumbnail_url);
        END IF;

        SELECT value INTO demos_domain
        FROM settings
        WHERE name = 'demos_domain';

        IF demos_domain IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(demos_domain, '/clips/', match_clips.id, '/thumbnail');
    END;
$$;
