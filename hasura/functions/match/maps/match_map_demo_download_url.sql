CREATE OR REPLACE FUNCTION public.match_map_demo_download_url(match_map public.match_maps)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    worker_url text;
    demos_domain text;
    has_external boolean;
BEGIN
    SELECT value INTO demos_domain
    FROM settings
    WHERE name = 'demos_domain';

    -- External (e.g. Valve) demos are served over HTTP-only CDNs, so linking
    -- them directly from an HTTPS page is blocked as mixed content. Route them
    -- through the API proxy (downloadDemo -> getDemo), which fetches the
    -- upstream file server-side and streams it back over HTTPS as an attachment.
    SELECT EXISTS (
        SELECT 1
          FROM public.match_map_demos d
         WHERE d.match_map_id = match_map.id
           AND d.file ~* '^https?://'
    ) INTO has_external;

    IF has_external THEN
        IF demos_domain IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN CONCAT(demos_domain, '/demos/', match_map.match_id, '/map/', match_map.id);
    END IF;

    SELECT value INTO worker_url
    FROM settings
    WHERE name = 'cloudflare_worker_url';

    IF worker_url IS NOT NULL THEN
        RETURN NULL;
    END IF;

    RETURN CONCAT(demos_domain, '/demos/', match_map.match_id, '/map/', match_map.id);
END;
$$;
