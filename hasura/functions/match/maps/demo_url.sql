drop function if exists public.demo_download_url(match_map public.match_maps);

CREATE OR REPLACE FUNCTION public._demo_download_url(
    _file text,
    _created_at timestamptz,
    _match_id uuid,
    _match_map_id uuid
)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        demos_domain text;
        version text;
    BEGIN
        IF _file ~* '^https?://' THEN
            RETURN _file;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM _created_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/demo?file=', _file, '&v=', version);
        END IF;

        SELECT value INTO demos_domain
        FROM settings
        WHERE name = 'demos_domain';

        IF demos_domain IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(
            demos_domain,
            '/demos/', _match_id,
            '/map/', _match_map_id,
            '?v=', version
        );
    END;
$$;

-- Takes the columns rather than the row: a demo row carries its kills, bombs
-- and players as jsonb, and building the row would unpack all of them.
CREATE OR REPLACE FUNCTION public.demo_download_url(match_map_demos public.match_map_demos)
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT public._demo_download_url(
        match_map_demos.file,
        match_map_demos.created_at,
        match_map_demos.match_id,
        match_map_demos.match_map_id
    );
$$;
