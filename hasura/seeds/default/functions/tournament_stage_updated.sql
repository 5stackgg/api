CREATE OR REPLACE FUNCTION public.tournament_stage_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
   	PERFORM update_tournament_stages(NEW.tournament_id);
   	RETURN NEW;
END;
$$;