-- A Swiss bye: a finished, teamless-opponent bracket that scores as a free win
-- for the given team (see v_team_stage_results_compute — bye => win). Used for
-- odd fields so the team's record still advances for the next round's pairing.
CREATE OR REPLACE FUNCTION public.create_swiss_bye_bracket(
    _stage_id uuid,
    _round int,
    _team_id uuid,
    _pool_group numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _match_number int;
BEGIN
    SELECT COALESCE(MAX(match_number), 0) + 1 INTO _match_number
    FROM tournament_brackets
    WHERE tournament_stage_id = _stage_id AND round = _round AND "group" = _pool_group;

    INSERT INTO tournament_brackets (
        round, tournament_stage_id, match_number, "group", path,
        tournament_team_id_1, bye, finished
    )
    VALUES (
        _round, _stage_id, _match_number, _pool_group, 'WB',
        _team_id, true, true
    );

    RAISE NOTICE '    Bye: team % gets a free win in round % (pool %)', _team_id, _round, _pool_group;
END;
$$;
