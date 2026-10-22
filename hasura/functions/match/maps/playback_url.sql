CREATE OR REPLACE FUNCTION public._demo_playback_url(
    _playback_file text,
    _metadata_parsed_at timestamptz,
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
        IF _playback_file IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM _metadata_parsed_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/demo?file=', _playback_file, '&v=', version);
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
            '/playback',
            '?v=', version
        );
    END;
$$;

-- Takes the columns rather than the row: a demo row carries its kills, bombs
-- and players as jsonb, and building the row would unpack all of them.
CREATE OR REPLACE FUNCTION public.demo_playback_url(match_map_demos public.match_map_demos)
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT public._demo_playback_url(
        match_map_demos.playback_file,
        match_map_demos.metadata_parsed_at,
        match_map_demos.match_id,
        match_map_demos.match_map_id
    );
$$;
