-- Detects and resolves "runtime byes" in elimination brackets.
-- A runtime bye occurs when a bracket receives exactly one team but has
-- no remaining feeder brackets that could provide the second team.
-- This happens in double-elimination losers brackets after LB R1 pruning:
-- the pruned LB R1 match can no longer feed its parent LB R2 bracket,
-- so the WB loser that drops into LB R2 has no opponent.
CREATE OR REPLACE FUNCTION public.resolve_bracket_bye(
    _bracket tournament_brackets
) RETURNS boolean
    LANGUAGE plpgsql
AS $$
DECLARE
    pending_feeders int;
    lone_team_id uuid;
    tournament_id uuid;
BEGIN
    -- Only applies when exactly one team is present
    IF (_bracket.tournament_team_id_1 IS NOT NULL AND _bracket.tournament_team_id_2 IS NOT NULL) THEN
        RETURN false;
    END IF;

    IF (_bracket.tournament_team_id_1 IS NULL AND _bracket.tournament_team_id_2 IS NULL) THEN
        RETURN false;
    END IF;

    IF _bracket.finished = true OR _bracket.match_id IS NOT NULL THEN
        RETURN false;
    END IF;

    -- Count unfinished, non-bye feeder brackets that could still send a team
    SELECT COUNT(*) INTO pending_feeders
    FROM tournament_brackets child
    WHERE (child.parent_bracket_id = _bracket.id
           OR child.loser_parent_bracket_id = _bracket.id)
      AND child.finished = false
      AND child.bye = false;

    IF pending_feeders > 0 THEN
        RETURN false;
    END IF;

    -- Runtime bye confirmed: one team, no pending feeders
    lone_team_id := COALESCE(_bracket.tournament_team_id_1, _bracket.tournament_team_id_2);

    RAISE NOTICE 'Resolving runtime bye: bracket %, team % advanced to parent %',
        _bracket.id, lone_team_id, _bracket.parent_bracket_id;

    -- Mark as bye and finished
    UPDATE tournament_brackets
    SET bye = true, finished = true
    WHERE id = _bracket.id;

    -- Advance the lone team to the parent bracket
    IF _bracket.parent_bracket_id IS NOT NULL THEN
        PERFORM public.assign_team_to_bracket_slot(_bracket.parent_bracket_id, lone_team_id);
    END IF;

    -- Check if tournament is now complete
    SELECT ts.tournament_id INTO tournament_id
    FROM tournament_stages ts
    WHERE ts.id = _bracket.tournament_stage_id;

    IF tournament_id IS NOT NULL THEN
        PERFORM check_tournament_finished(tournament_id);
    END IF;

    RETURN true;
END;
$$;
