CREATE OR REPLACE FUNCTION public.clone_tournament_bracket_options(
    _bracket_id uuid,
    hasura_session json
) RETURNS SETOF public.tournament_brackets
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
BEGIN
    SELECT t.* INTO _tournament
    FROM public.tournament_brackets tb
    INNER JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
    INNER JOIN public.tournaments t ON t.id = ts.tournament_id
    WHERE tb.id = _bracket_id;

    IF NOT FOUND OR NOT public.is_tournament_organizer(_tournament, hasura_session) THEN
        RAISE EXCEPTION 'Must be an organizer of this tournament' USING ERRCODE = '22000';
    END IF;

    UPDATE public.tournament_brackets tb
    SET match_options_id = public.clone_match_options(COALESCE(ts.match_options_id, _tournament.match_options_id))
    FROM public.tournament_stages ts
    WHERE tb.id = _bracket_id
      AND ts.id = tb.tournament_stage_id
      AND tb.match_options_id IS NULL;

    RETURN QUERY SELECT * FROM public.tournament_brackets WHERE id = _bracket_id;
END;
$$;
