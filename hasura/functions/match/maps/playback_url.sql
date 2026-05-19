CREATE OR REPLACE FUNCTION public.demo_playback_url(match_map_demos public.match_map_demos)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        demos_domain text;
    BEGIN
        IF match_map_demos.playback_file IS NULL THEN
            RETURN NULL;
        END IF;

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/demo?file=', match_map_demos.playback_file);
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
            '/playback'
        );
    END;
$$;
