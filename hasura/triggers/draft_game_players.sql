CREATE OR REPLACE FUNCTION public.tbi_draft_game_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    game public.draft_games%ROWTYPE;
    actor text;
    accepted_count integer;
    player_elo jsonb;
BEGIN
    SELECT * INTO game FROM public.draft_games WHERE id = NEW.draft_game_id;

    IF NEW.elo_snapshot IS NULL THEN
        SELECT public.get_player_elo(p) INTO player_elo FROM public.players p WHERE p.steam_id = NEW.steam_id;
        NEW.elo_snapshot := COALESCE(NULLIF(player_elo ->> lower(game.type), '')::numeric::integer, 5000);
    END IF;

    actor := NULLIF(current_setting('hasura.user', true), '')::json ->> 'x-hasura-user-id';

    IF actor IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO accepted_count
    FROM public.draft_game_players
    WHERE draft_game_id = NEW.draft_game_id AND status = 'Accepted';

    IF NEW.steam_id = game.host_steam_id THEN
        NEW.status := 'Accepted';
    ELSIF actor = game.host_steam_id::text THEN
        NEW.status := 'Accepted';
    ELSIF accepted_count >= game.capacity OR game.status <> 'Open' THEN
        NEW.status := 'Waitlist';
    ELSIF game.require_approval THEN
        NEW.status := 'Requested';
    ELSE
        NEW.status := 'Accepted';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_draft_game_players ON public.draft_game_players;
CREATE TRIGGER tbi_draft_game_players BEFORE INSERT ON public.draft_game_players FOR EACH ROW EXECUTE FUNCTION public.tbi_draft_game_players();


CREATE OR REPLACE FUNCTION public.tai_draft_game_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'Accepted' THEN
        DELETE FROM public.draft_game_players dp
        USING public.draft_games g
        WHERE dp.draft_game_id = g.id
            AND dp.steam_id = NEW.steam_id
            AND dp.draft_game_id <> NEW.draft_game_id
            AND g.status NOT IN ('Completed', 'Canceled')
            AND g.host_steam_id <> NEW.steam_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_draft_game_players ON public.draft_game_players;
CREATE TRIGGER tai_draft_game_players AFTER INSERT ON public.draft_game_players FOR EACH ROW EXECUTE FUNCTION public.tai_draft_game_players();


CREATE OR REPLACE FUNCTION public.tad_draft_game_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    game public.draft_games%ROWTYPE;
    remaining integer;
    accepted_count integer;
    new_host bigint;
    promote_steam_id bigint;
BEGIN
    SELECT * INTO game FROM public.draft_games WHERE id = OLD.draft_game_id;
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    IF game.status IN ('Completed', 'CreatingMatch') OR game.match_id IS NOT NULL THEN
        RETURN OLD;
    END IF;

    -- leaving once the draft has started tears the whole draft down
    IF game.status <> 'Open' THEN
        DELETE FROM public.draft_games WHERE id = game.id;
        RETURN OLD;
    END IF;

    SELECT count(*) INTO remaining FROM public.draft_game_players WHERE draft_game_id = game.id;
    IF remaining = 0 THEN
        DELETE FROM public.draft_games WHERE id = game.id;
        RETURN OLD;
    END IF;

    IF OLD.steam_id = game.host_steam_id THEN
        SELECT steam_id INTO new_host
        FROM public.draft_game_players
        WHERE draft_game_id = game.id AND status = 'Accepted'
        ORDER BY joined_at ASC LIMIT 1;

        IF new_host IS NULL THEN
            DELETE FROM public.draft_games WHERE id = game.id;
            RETURN OLD;
        END IF;

        UPDATE public.draft_games SET host_steam_id = new_host, updated_at = now() WHERE id = game.id;
    END IF;

    LOOP
        SELECT count(*) INTO accepted_count
        FROM public.draft_game_players WHERE draft_game_id = game.id AND status = 'Accepted';
        EXIT WHEN accepted_count >= game.capacity;

        -- A backup is pinned to the side it subs for, so promoting one from the
        -- other team would leave that side over capacity while this one is short.
        SELECT steam_id INTO promote_steam_id
        FROM public.draft_game_players
        WHERE draft_game_id = game.id AND status = 'Waitlist'
          AND (OLD.lineup IS NULL OR lineup IS NULL OR lineup = OLD.lineup)
        ORDER BY (lineup IS DISTINCT FROM OLD.lineup), joined_at ASC LIMIT 1;
        EXIT WHEN promote_steam_id IS NULL;

        UPDATE public.draft_game_players SET status = 'Accepted'
        WHERE draft_game_id = game.id AND steam_id = promote_steam_id;
    END LOOP;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_draft_game_players ON public.draft_game_players;
CREATE TRIGGER tad_draft_game_players AFTER DELETE ON public.draft_game_players FOR EACH ROW EXECUTE FUNCTION public.tad_draft_game_players();
