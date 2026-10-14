-- Whether a discovered throw is one nobody has written up or been seen running:
-- no public lineup and no meta cluster stands within 64 units of it and lands
-- within 64 units of where it lands.
--
-- Distances rather than lineup_bucket: a bucket is a 64-unit grid cell, so a
-- throw a unit across a cell edge from a famous lineup would count as new.
-- Public lineups only, so the badge never tells anybody where somebody else's
-- private lineup is.
CREATE OR REPLACE FUNCTION public.utility_discovery_is_new(
    _map_name text,
    _utility_type text,
    _stand_x double precision,
    _stand_y double precision,
    _land_x double precision,
    _land_y double precision
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT NOT EXISTS (
        SELECT 1
          FROM public.utility_lineups l
         WHERE l.map_name = _map_name
           AND l.utility_type = _utility_type
           AND l.visibility = 'Public'
           AND l.archived_at IS NULL
           AND (l.origin_x - _stand_x) ^ 2 + (l.origin_y - _stand_y) ^ 2 <= 4096
           AND (l.land_x - _land_x) ^ 2 + (l.land_y - _land_y) ^ 2 <= 4096
    )
    AND NOT EXISTS (
        SELECT 1
          FROM public.utility_meta_lineups m
         WHERE m.map_name = _map_name
           AND m.utility_type = _utility_type
           AND (m.origin_x - _stand_x) ^ 2 + (m.origin_y - _stand_y) ^ 2 <= 4096
           AND (m.land_x - _land_x) ^ 2 + (m.land_y - _land_y) ^ 2 <= 4096
    );
$$;
