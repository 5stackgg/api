CREATE OR REPLACE FUNCTION public.match_map_demo_download_url(match_map public.match_maps)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    worker_url text;
    filenames text[];
    demos_domain text;
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.match_map_demos d
         WHERE d.match_map_id = match_map.id
           AND d.file ~* '^https?://'
    ) THEN
        RETURN NULL;
    END IF;

    SELECT value INTO worker_url
    FROM settings
    WHERE name = 'cloudflare_worker_url';

    IF worker_url IS NOT NULL THEN
        RETURN NULL;
    END IF;

    SELECT value INTO demos_domain
    FROM settings
    WHERE name = 'demos_domain';

    RETURN CONCAT(demos_domain, '/demos/', match_map.match_id, '/map/', match_map.id);
END;
$$;
