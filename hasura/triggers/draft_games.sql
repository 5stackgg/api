CREATE OR REPLACE FUNCTION public.tbi_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.capacity := CASE NEW.type
        WHEN 'Duel' THEN 2
        WHEN 'Wingman' THEN 4
        ELSE 10
    END;

    IF NEW.mode = 'Teams' AND NEW.team_1_id IS NOT NULL AND NEW.team_2_id IS NOT NULL THEN
        NEW.access := 'Private';
    END IF;

    NEW.expires_at := now() + interval '30 minutes';

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_draft_games ON public.draft_games;
CREATE TRIGGER tbi_draft_games BEFORE INSERT ON public.draft_games FOR EACH ROW EXECUTE FUNCTION public.tbi_draft_games();


CREATE OR REPLACE FUNCTION public.tbu_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    accepted_count integer;
    team1 integer;
    team2 integer;
BEGIN
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at AND NEW.expires_at IS NOT NULL THEN
        NEW.expires_at := LEAST(NEW.expires_at, NEW.created_at + interval '120 minutes');
    END IF;

    -- Reject an unready "start" so the row can never get stuck in Filled.
    IF OLD.status = 'Open' AND NEW.status = 'Filled' THEN
        SELECT
            count(*) FILTER (WHERE status = 'Accepted'),
            count(*) FILTER (WHERE status = 'Accepted' AND lineup = 1),
            count(*) FILTER (WHERE status = 'Accepted' AND lineup = 2)
        INTO accepted_count, team1, team2
        FROM public.draft_game_players
        WHERE draft_game_id = NEW.id;

        IF NEW.mode = 'Teams' THEN
            IF NEW.team_1_id IS NULL THEN
                RAISE EXCEPTION 'Select at least one team first' USING ERRCODE = '22000';
            END IF;
        ELSIF NEW.mode = 'Host' THEN
            IF team1 <> NEW.capacity / 2 OR team2 <> NEW.capacity / 2 THEN
                RAISE EXCEPTION 'Assign all players into balanced teams first' USING ERRCODE = '22000';
            END IF;
        ELSE
            IF accepted_count <> NEW.capacity THEN
                RAISE EXCEPTION 'The lobby must be full to start' USING ERRCODE = '22000';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_draft_games ON public.draft_games;
CREATE TRIGGER tbu_draft_games BEFORE UPDATE ON public.draft_games FOR EACH ROW EXECUTE FUNCTION public.tbu_draft_games();


CREATE OR REPLACE FUNCTION public.tad_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.match_options_id IS NOT NULL THEN
        DELETE FROM public.match_options WHERE id = OLD.match_options_id;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_draft_games ON public.draft_games;
CREATE TRIGGER tad_draft_games AFTER DELETE ON public.draft_games FOR EACH ROW EXECUTE FUNCTION public.tad_draft_games();
