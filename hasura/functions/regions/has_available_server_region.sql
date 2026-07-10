drop function if exists public.has_available_server_region();
CREATE OR REPLACE FUNCTION public.has_available_server_region() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
        SELECT EXISTS (
            SELECT 1
            FROM server_regions sr
            WHERE total_region_server_count(sr) > 0
        );
$$;
