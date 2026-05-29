drop function if exists public.demo_download_url(match_map public.match_maps);

CREATE OR REPLACE FUNCTION public.demo_download_url(match_map_demos public.match_map_demos)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        demos_domain text;
        version text;
    BEGIN
        IF match_map_demos.file ~* '^https?://' THEN
            RETURN match_map_demos.file;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM match_map_demos.created_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/demo?file=', match_map_demos.file, '&v=', version);
        END IF;

        SELECT value INTO demos_domain
        FROM settings
        WHERE name = 'demos_domain';

        IF demos_domain IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(
            demos_domain,
            '/demos/', match_map_demos.match_id,
            '/map/', match_map_demos.match_map_id,
            '?v=', version
        );
    END;
$$;
