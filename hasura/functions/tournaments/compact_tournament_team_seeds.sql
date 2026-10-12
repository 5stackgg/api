CREATE OR REPLACE FUNCTION public.compact_tournament_team_seeds(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _team_ids uuid[];
BEGIN
    SELECT array_agg(tt.id ORDER BY tt.seed)
      INTO _team_ids
      FROM public.tournament_teams tt
     WHERE tt.tournament_id = _tournament_id
       AND tt.seed IS NOT NULL;

    -- Two passes: (tournament_id, seed) is unique and checked row by row, so a
    -- team written straight to its new seed can land on one another team has
    -- not left yet. There is no CHECK on seed either, so the old values cannot
    -- be relied on to sit above the new ones.
    UPDATE public.tournament_teams tt
       SET seed = NULL
      FROM unnest(_team_ids) WITH ORDINALITY AS ranked(id, seed)
     WHERE tt.id = ranked.id
       AND tt.seed <> ranked.seed;

    UPDATE public.tournament_teams tt
       SET seed = ranked.seed
      FROM unnest(_team_ids) WITH ORDINALITY AS ranked(id, seed)
     WHERE tt.id = ranked.id
       AND tt.seed IS NULL;
END;
$$;
