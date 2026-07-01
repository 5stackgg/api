CREATE OR REPLACE FUNCTION public.tbi_draft_game_picks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    game public.draft_games%ROWTYPE;
    actor text;
    expected_lineup int;
    captain public.draft_game_players%ROWTYPE;
BEGIN
    -- serialize concurrent picks for the same draft so the turn count can't race
    SELECT * INTO game FROM public.draft_games WHERE id = NEW.draft_game_id FOR UPDATE;

    expected_lineup := public.get_draft_game_picking_lineup_id(game);

    actor := NULLIF(current_setting('hasura.user', true), '')::json ->> 'x-hasura-user-id';

    -- server-side auto picks run without a session and stamp their own row
    IF actor IS NULL THEN
        RETURN NEW;
    END IF;

    IF expected_lineup IS NULL THEN
        RAISE EXCEPTION 'Drafting is not in progress' USING ERRCODE = '22000';
    END IF;

    SELECT * INTO captain FROM public.draft_game_players
    WHERE draft_game_id = NEW.draft_game_id
      AND is_captain = true
      AND lineup = expected_lineup;

    IF NOT FOUND OR captain.steam_id::text <> actor THEN
        RAISE EXCEPTION 'It is not your turn to pick' USING ERRCODE = '22000';
    END IF;

    NEW.captain_steam_id := captain.steam_id;
    NEW.lineup := expected_lineup;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_draft_game_picks ON public.draft_game_picks;
CREATE TRIGGER tbi_draft_game_picks BEFORE INSERT ON public.draft_game_picks FOR EACH ROW EXECUTE FUNCTION public.tbi_draft_game_picks();


CREATE OR REPLACE FUNCTION public.tai_draft_game_picks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.apply_draft_game_pick(NEW);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_draft_game_picks ON public.draft_game_picks;
CREATE TRIGGER tai_draft_game_picks AFTER INSERT ON public.draft_game_picks FOR EACH ROW EXECUTE FUNCTION public.tai_draft_game_picks();
