-- Round robin and Swiss results are read again after they land: a finished
-- stage seeds the next one from its standings, and a finished Swiss round
-- pairs the next round by record. Once that has happened, taking the result
-- back would leave teams placed by a result that no longer exists. A league
-- season that finished, or a relegation playoff that resolved, already moved
-- teams between divisions, whatever the stage type.
--
-- Final-round Swiss winners are linked into the next stage as each match ends,
-- before the stage is over. The reset unwinds that slot like an elimination
-- result, so only a finished stage counts as seeded.
CREATE OR REPLACE FUNCTION public.tournament_result_lock_reason(_bracket_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _bracket tournament_brackets%ROWTYPE;
    _stage tournament_stages%ROWTYPE;
BEGIN
    SELECT * INTO _bracket
    FROM tournament_brackets
    WHERE id = _bracket_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _stage
    FROM tournament_stages
    WHERE id = _bracket.tournament_stage_id;

    IF EXISTS (
        SELECT 1
        FROM league_relegation_playoffs playoff
        WHERE playoff.tournament_id = _stage.tournament_id
          AND playoff.resolved_at IS NOT NULL
    ) THEN
        RETURN 'this playoff already decided the promotions and relegations';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM league_season_divisions division
        JOIN league_seasons season ON season.id = division.league_season_id
        WHERE division.tournament_id = _stage.tournament_id
          AND season.status = 'Finished'
    ) THEN
        RETURN 'the league season already finished and moved teams between divisions';
    END IF;

    IF _stage.type NOT IN ('RoundRobin', 'Swiss') THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM tournament_brackets unfinished
        WHERE unfinished.tournament_stage_id = _stage.id
          AND unfinished.finished = false
    ) AND EXISTS (
        SELECT 1
        FROM tournament_stages next_stage
        JOIN tournament_brackets next_bracket
          ON next_bracket.tournament_stage_id = next_stage.id
        WHERE next_stage.tournament_id = _stage.tournament_id
          AND next_stage."order" = _stage."order" + 1
          AND (
              next_bracket.tournament_team_id_1 IS NOT NULL
              OR next_bracket.tournament_team_id_2 IS NOT NULL
          )
    ) THEN
        RETURN 'the next stage was already seeded from these standings';
    END IF;

    IF _stage.type = 'Swiss' AND EXISTS (
        SELECT 1
        FROM tournament_brackets later
        WHERE later.tournament_stage_id = _stage.id
          AND later.round > _bracket.round
          AND (
              later.tournament_team_id_1 IS NOT NULL
              OR later.tournament_team_id_2 IS NOT NULL
          )
    ) THEN
        RETURN 'the next Swiss round was already paired from this result';
    END IF;

    RETURN NULL;
END;
$$;
