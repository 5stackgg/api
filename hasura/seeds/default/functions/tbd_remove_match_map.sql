CREATE FUNCTION public.tbd_remove_match_map() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM match_maps WHERE map_id = OLD.map_id AND match_id = OLD.match_id;
    RETURN OLD;
END;
$$;