CREATE OR REPLACE FUNCTION public.is_server_available(match_id uuid, match_server_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM servers s
        WHERE s.id = match_server_id AND reserved_by_match_id is not null AND match_id != reserved_by_match_id
    ) THEN
        RETURN false;
    END IF;
    RETURN true;
END;
$$;