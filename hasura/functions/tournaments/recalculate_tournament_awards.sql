CREATE OR REPLACE FUNCTION public.recalculate_tournament_awards(_tournament_id uuid)
RETURNS SETOF public.award_recipients
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.award_recipients
    WHERE tournament_id = _tournament_id;

    PERFORM public.calculate_tournament_awards(_tournament_id);
    RETURN QUERY SELECT * FROM public.award_recipients WHERE tournament_id = _tournament_id;
END;
$$;
