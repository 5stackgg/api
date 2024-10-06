CREATE OR REPLACE FUNCTION public.tbi_match() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    lan_match BOOLEAN;
    _lineup_1_id UUID;
    _lineup_2_id UUID;
    _regions text[];
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

    SELECT regions INTO _regions FROM match_options WHERE id = NEW.match_options_id;

    IF array_length(_regions, 1) != 0 THEN
        SELECT array_agg(sr.value) INTO available_regions 
        FROM e_server_regions sr
        WHERE sr.value = ANY(_regions)
        AND available_region_server_count(sr) > 0;
    ELSE
        SELECT array_agg(sr.value) INTO available_regions 
        FROM e_server_regions sr
        WHERE available_region_server_count(sr) > 0
        AND sr.value != 'Lan';
    END IF;

    IF array_length(available_regions, 1) = 1 THEN
        NEW.region = available_regions[1];
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_match ON public.matches;
CREATE TRIGGER tbi_match BEFORE INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbi_match();

CREATE OR REPLACE FUNCTION public.tai_match() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _map_id UUID;
    _map_pool_id UUID;
    _best_of int;
    available_regions text[];
    map_pool_count int;
BEGIN
    SELECT map_pool_id, best_of INTO _map_pool_id, _best_of FROM match_options WHERE id = NEW.match_options_id;

    SELECT COUNT(*) INTO map_pool_count FROM _map_pool WHERE map_pool_id = _map_pool_id;

    IF map_pool_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Match requires at least one map selected';
    END IF;

    IF _best_of > map_pool_count THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Not enough maps in the pool for the best of ' || _best_of;
    END IF;

    SELECT map_id INTO _map_id FROM _map_pool WHERE map_pool_id = _map_pool_id LIMIT 1;

    IF map_pool_count = 1 THEN 
        INSERT INTO match_maps (match_id, map_id, "order", lineup_1_side, lineup_2_side)
            VALUES (NEW.id, _map_id, 1, 'CT', 'TERRORIST');
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tai_match ON public.matches;
CREATE TRIGGER tai_match AFTER INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tai_match();

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
        IF NEW.scheduled_at IS NOT NULL THEN
           NEW.cancels_at = NOW() + INTERVAL '15 minutes';
        END IF;
        
        NEW.ended_at = null;
    END IF;


     IF (NEW.status = 'Veto' AND OLD.status != 'Veto')  THEN
        NEW.cancels_at = NOW() + INTERVAL '10 minutes';
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
