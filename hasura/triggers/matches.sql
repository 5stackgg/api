CREATE OR REPLACE FUNCTION public.tbi_match() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_1_id UUID;
    _lineup_2_id UUID;
    available_regions text[];
BEGIN
    IF NEW.lineup_1_id IS NULL THEN
        INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
         NEW.lineup_1_id = _lineup_1_id;
    END IF;

    IF NEW.lineup_2_id IS NULL THEN
       INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;
       NEW.lineup_2_id = _lineup_2_id;
    END IF;

    select array_agg(gsr.value) INTO available_regions from e_game_server_node_regions gsr
        INNER JOIN game_server_nodes gsn on gsn.region = gsr.value
        where gsn.region != 'Lan';

    IF array_length(available_regions, 1) = 1 THEN
        NEW.region = available_regions[1];
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_match ON public.matches;
CREATE TRIGGER tbi_match BEFORE INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbi_match();


CREATE OR REPLACE FUNCTION public.tau_matches() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_tournament_bracket(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_matches ON public.matches;
CREATE TRIGGER tau_matches AFTER UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tau_matches();

CREATE OR REPLACE FUNCTION public.tbu_matches() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF(OLD.status = 'Finished' AND NEW.status = 'Canceled') THEN
      RAISE EXCEPTION 'Cannot cancel a match that is already finished' USING ERRCODE = '22000';
    END IF;

    IF NEW.scheduled_at IS NOT NULL AND NEW.status = 'Scheduled' THEN
        NEW.cancels_at = null;
        NEW.ended_at = null;
    END IF;

    IF (NEW.status = 'WaitingForCheckIn' AND OLD.status != 'WaitingForCheckIn')  THEN
        IF NEW.scheduled_at THEN
            -- we already give them 15 minutes to check in before the match starts
            NEW.cancels_at = NEW.scheduled_at + INTERVAL '5 minutes';
        ELSE
            NEW.cancels_at = NOW() + INTERVAL '15 minutes';
        END IF;
        
        NEW.ended_at = null;
    END IF;


     IF (NEW.status = 'Veto' AND OLD.status != 'Veto')  THEN
        NEW.cancels_at = NOW() + INTERVAL '5 minutes';
        NEW.ended_at = null;
    END IF;

    IF NEW.status = 'WaitingForServer' AND OLD.status != 'WaitingForServer' THEN
        NEW.cancels_at = null;
        NEW.ended_at = null;
    END IF;

    IF NEW.status = 'Live' AND OLD.status != 'Live' THEN
        NEW.started_at = NOW();
        NEW.cancels_at = null;
        NEW.ended_at = null;
    END IF;

    IF 
        (NEW.status = 'Finished' AND OLD.status != 'Finished')
        OR (NEW.status = 'Canceled' AND OLD.status != 'Canceled')
        OR (NEW.status = 'Forfeit' AND OLD.status != 'Forfeit')
        OR (NEW.status = 'Tie' AND OLD.status != 'Tie')
    THEN
        NEW.ended_at = NOW();
        NEW.cancels_at = null;
    END IF;

    PERFORM check_match_status(NEW);
    PERFORM check_match_player_count(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_matches ON public.matches;
CREATE TRIGGER tbu_matches BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_matches();

CREATE OR REPLACE FUNCTION public.tad_matches() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM tournaments
        WHERE match_options_id = OLD.match_options_id
    )
    THEN
        DELETE FROM match_options
        WHERE id = OLD.match_options_id;
    END IF;

    update servers set reserved_by_match_id = null where reserved_by_match_id = OLD.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tad_matches ON public.matches;
CREATE TRIGGER tad_matches AFTER DELETE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tad_matches();
