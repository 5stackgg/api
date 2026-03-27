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
    current_bracket tournament_brackets%ROWTYPE;
    pending_feeders int;
    lone_team_id uuid;
    tournament_id uuid;
BEGIN
    -- Re-read from disk: the passed-in row may be stale when called from
    -- a resume loop where earlier iterations cascaded and already resolved this bracket.
    SELECT * INTO current_bracket
    FROM tournament_brackets WHERE id = _bracket.id;

    IF current_bracket IS NULL THEN
        RETURN false;
    END IF;

    -- Only applies when exactly one team is present
    IF (current_bracket.tournament_team_id_1 IS NOT NULL AND current_bracket.tournament_team_id_2 IS NOT NULL) THEN
        RETURN false;
    END IF;

    IF (current_bracket.tournament_team_id_1 IS NULL AND current_bracket.tournament_team_id_2 IS NULL) THEN
        RETURN false;
    END IF;

    IF current_bracket.finished = true OR current_bracket.match_id IS NOT NULL THEN
        RETURN false;
    END IF;

    -- Check if any feeders can still provide a team.
    -- A finished bye feeder via loser_parent_bracket_id will never send a loser,
    -- so it doesn't count as pending. Only unfinished feeders are pending.
    SELECT COUNT(*) INTO pending_feeders
    FROM tournament_brackets child
    WHERE (child.parent_bracket_id = current_bracket.id
           OR child.loser_parent_bracket_id = current_bracket.id)
      AND child.finished = false;

    IF pending_feeders > 0 THEN
        RETURN false;
    END IF;

    -- Runtime bye confirmed: one team, no pending feeders
    lone_team_id := COALESCE(current_bracket.tournament_team_id_1, current_bracket.tournament_team_id_2);

    RAISE NOTICE 'Resolving runtime bye: bracket %, team % advanced to parent %',
        current_bracket.id, lone_team_id, current_bracket.parent_bracket_id;

    -- Mark as bye and finished
    UPDATE tournament_brackets
    SET bye = true, finished = true
    WHERE id = current_bracket.id;

    -- Advance the lone team to the parent bracket
    IF current_bracket.parent_bracket_id IS NOT NULL THEN
        PERFORM public.assign_team_to_bracket_slot(current_bracket.parent_bracket_id, lone_team_id, current_bracket.id);
    ELSE
        RAISE WARNING 'resolve_bracket_bye: bracket % has no parent, team % cannot advance',
            current_bracket.id, lone_team_id;
    END IF;

    -- Check if tournament is now complete
    SELECT ts.tournament_id INTO tournament_id
    FROM tournament_stages ts
    WHERE ts.id = current_bracket.tournament_stage_id;

    IF tournament_id IS NOT NULL THEN
        PERFORM check_tournament_finished(tournament_id);
    END IF;

    RETURN true;
END;
$$;
