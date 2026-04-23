drop function if exists public.sanitize_match_options_regions(uuid);
CREATE OR REPLACE FUNCTION public.sanitize_match_options_regions(_match_options_id uuid) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    _regions text[];
    _sanitized_regions text[];
BEGIN
    SELECT mo.regions INTO _regions
    FROM match_options mo
    WHERE mo.id = _match_options_id;

    IF _regions IS NOT NULL AND array_length(_regions, 1) > 0 THEN
        SELECT array_agg(s.value ORDER BY s.ordinality) INTO _sanitized_regions
        FROM (
            SELECT DISTINCT ON (lower(sr.value))
                sr.value,
                u.ordinality
            FROM unnest(_regions) WITH ORDINALITY AS u(region, ordinality)
            INNER JOIN server_regions sr ON lower(sr.value) = lower(u.region)
            WHERE total_region_server_count(sr) > 0
            ORDER BY lower(sr.value), u.ordinality
        ) s;
    END IF;

    IF _regions IS NULL OR array_length(_regions, 1) = 0 THEN
        _sanitized_regions := COALESCE(_regions, ARRAY[]::text[]);
    END IF;

    IF _sanitized_regions IS NULL THEN
        _sanitized_regions := ARRAY[]::text[];
    END IF;

    IF array_length(_sanitized_regions, 1) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'No regions with attached servers available for match veto.';
    END IF;

    IF _regions IS DISTINCT FROM _sanitized_regions THEN
        UPDATE match_options
        SET regions = _sanitized_regions
        WHERE id = _match_options_id;
    END IF;

    RETURN _sanitized_regions;
END;
$$;
