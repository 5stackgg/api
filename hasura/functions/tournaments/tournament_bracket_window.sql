-- The scheduling window a tournament bracket belongs to (window.round =
-- bracket.round within its stage). Returns NULL when the stage has no window
-- configured for that round (e.g. an auto-scheduled tournament, or a stage
-- whose rounds are not window-gated).
CREATE OR REPLACE FUNCTION public.tournament_bracket_window(_tournament_bracket_id uuid)
RETURNS public.tournament_stage_windows
LANGUAGE sql
STABLE
AS $$
    SELECT tsw.*
    FROM public.tournament_brackets tb
    JOIN public.tournament_stage_windows tsw
      ON tsw.tournament_stage_id = tb.tournament_stage_id
     AND tsw.round = tb.round
    WHERE tb.id = _tournament_bracket_id;
$$;
