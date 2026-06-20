CREATE OR REPLACE FUNCTION public.tbi_draft_game_picks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    game public.draft_games%ROWTYPE;
    actor text;
    captain public.draft_game_players%ROWTYPE;
BEGIN
    actor := NULLIF(current_setting('hasura.user', true), '')::json ->> 'x-hasura-user-id';

    IF actor IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO game FROM public.draft_games WHERE id = NEW.draft_game_id;

    SELECT * INTO captain FROM public.draft_game_players
    WHERE draft_game_id = NEW.draft_game_id
      AND is_captain = true
      AND lineup = game.current_pick_lineup;

    IF NOT FOUND OR captain.steam_id::text <> actor THEN
        RAISE EXCEPTION 'It is not your turn to pick' USING ERRCODE = '22000';
    END IF;

    NEW.captain_steam_id := captain.steam_id;
    NEW.lineup := game.current_pick_lineup;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_draft_game_picks ON public.draft_game_picks;
CREATE TRIGGER tbi_draft_game_picks BEFORE INSERT ON public.draft_game_picks FOR EACH ROW EXECUTE FUNCTION public.tbi_draft_game_picks();
