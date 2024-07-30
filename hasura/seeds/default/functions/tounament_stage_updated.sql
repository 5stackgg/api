CREATE FUNCTION public.tounament_stage_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
   	RETURN NEW;
END;
$$;