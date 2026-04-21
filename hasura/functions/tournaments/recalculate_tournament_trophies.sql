CREATE OR REPLACE FUNCTION public.recalculate_tournament_trophies(_tournament_id uuid)
RETURNS SETOF public.tournament_trophies
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.tournament_trophies
    WHERE tournament_id = _tournament_id;

    PERFORM public.calculate_tournament_trophies(_tournament_id);
    RETURN QUERY SELECT * FROM public.tournament_trophies WHERE tournament_id = _tournament_id;
END;
$$;
