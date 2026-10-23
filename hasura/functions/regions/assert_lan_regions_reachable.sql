-- Below match_organizer a LAN region is only open to a session the LAN probe
-- placed on it. The api's auth hook lists those regions, as a JSON array, in
-- x-hasura-lan-regions.
CREATE OR REPLACE FUNCTION public.lan_region_reachable(_region text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT s.session ->> 'x-hasura-role' IS NULL
        OR COALESCE(is_above_role('match_organizer', s.session), false)
        OR _region IN (
            SELECT json_array_elements_text(
                COALESCE(s.session ->> 'x-hasura-lan-regions', '[]')::json
            )
        )
    FROM (SELECT NULLIF(current_setting('hasura.user', true), '')::json AS session) s;
$$;

-- clone_match_options sets fivestack.regions_system_write: a copy's regions
-- were checked when somebody chose them.
CREATE OR REPLACE FUNCTION public.assert_lan_regions_reachable(_regions text[]) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF current_setting('fivestack.regions_system_write', true) = 'true' THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM server_regions sr
        WHERE lower(sr.value) IN (SELECT lower(region) FROM unnest(_regions) AS region)
          AND sr.is_lan = true
          AND NOT lan_region_reachable(sr.value)
    ) THEN
        RAISE EXCEPTION 'You must be on the LAN to play in a LAN region' USING ERRCODE = '22000';
    END IF;
END;
$$;
