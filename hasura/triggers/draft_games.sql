CREATE OR REPLACE FUNCTION public.tbi_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _mode_capacity integer;
BEGIN
    IF NOT has_available_server_region() THEN
        RAISE EXCEPTION 'No game server regions are currently available' USING ERRCODE = '22000';
    END IF;

    -- A custom mode can size its own teams; everything else falls back to the
    -- match type. match_options is inserted before the draft row, so the mode is
    -- already reachable here.
    SELECT gm.players_per_team * 2 INTO _mode_capacity
    FROM public.match_options mo
    INNER JOIN public.game_modes gm ON gm.id = mo.game_mode_id
    WHERE mo.id = NEW.match_options_id;

    NEW.capacity := COALESCE(_mode_capacity, CASE NEW.type
        WHEN 'Duel' THEN 2
        WHEN 'Wingman' THEN 4
        ELSE 10
    END);

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
    short_handed boolean;
BEGIN
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at AND NEW.expires_at IS NOT NULL THEN
        NEW.expires_at := LEAST(NEW.expires_at, NEW.created_at + interval '120 minutes');
    END IF;

    -- Reject an unready "start" so the row can never get stuck in Filled.
    IF OLD.status = 'Open' AND NEW.status = 'Filled' THEN
        -- Match creation would fail on the region sanitizer and strand the
        -- draft in CreatingMatch, so refuse the start outright.
        IF NOT has_available_server_region() THEN
            RAISE EXCEPTION 'No game server regions are currently available' USING ERRCODE = '22000';
        END IF;

        SELECT
            count(*) FILTER (WHERE status = 'Accepted'),
            count(*) FILTER (WHERE status = 'Accepted' AND lineup = 1),
            count(*) FILTER (WHERE status = 'Accepted' AND lineup = 2)
        INTO accepted_count, team1, team2
        FROM public.draft_game_players
        WHERE draft_game_id = NEW.id;

        -- A custom mode may permit starting before both sides are full. The
        -- lobby still has to hold a real match: at least one player a side, and
        -- an even pool for Captains, whose pick pattern is built on capacity / 2
        -- and produces a malformed order for an odd number of players.
        SELECT COALESCE(gm.allow_short_handed_start, false) INTO short_handed
        FROM public.match_options mo
        INNER JOIN public.game_modes gm ON gm.id = mo.game_mode_id
        WHERE mo.id = NEW.match_options_id;

        short_handed := COALESCE(short_handed, false);

        IF NEW.mode = 'Teams' THEN
            IF NEW.team_1_id IS NULL THEN
                RAISE EXCEPTION 'Select at least one team first' USING ERRCODE = '22000';
            END IF;
        ELSIF NEW.mode = 'Host' THEN
            IF short_handed THEN
                IF team1 < 1 OR team2 < 1 THEN
                    RAISE EXCEPTION 'Assign at least one player to each team first' USING ERRCODE = '22000';
                END IF;
            ELSIF team1 <> NEW.capacity / 2 OR team2 <> NEW.capacity / 2 THEN
                RAISE EXCEPTION 'Assign all players into balanced teams first' USING ERRCODE = '22000';
            END IF;
        ELSE
            IF short_handed THEN
                IF accepted_count < 2 THEN
                    RAISE EXCEPTION 'At least two players must accept before starting' USING ERRCODE = '22000';
                END IF;

                IF NEW.mode = 'Captains' AND accepted_count % 2 <> 0 THEN
                    RAISE EXCEPTION 'A captains draft needs an even number of players' USING ERRCODE = '22000';
                END IF;
            ELSIF accepted_count <> NEW.capacity THEN
                RAISE EXCEPTION 'The lobby must be full to start' USING ERRCODE = '22000';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_draft_games ON public.draft_games;
CREATE TRIGGER tbu_draft_games BEFORE UPDATE ON public.draft_games FOR EACH ROW EXECUTE FUNCTION public.tbu_draft_games();


-- Deleting unconditionally fails: tbd_matches removes the draft_games row
-- before the owning matches row is gone, and matches.match_options_id still
-- points at it (ON DELETE RESTRICT). tad_matches cleans up afterwards.
DROP TRIGGER IF EXISTS tad_draft_games ON public.draft_games;
CREATE TRIGGER tad_draft_games AFTER DELETE ON public.draft_games FOR EACH ROW EXECUTE FUNCTION public.tad_cleanup_match_options();
DROP FUNCTION IF EXISTS public.tad_draft_games();
