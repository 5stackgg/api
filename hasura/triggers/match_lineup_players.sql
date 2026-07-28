DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
drop function if exists public.tbi_match_lineup_players;

CREATE OR REPLACE FUNCTION public.tbu_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.captain = true AND NEW.match_lineup_id != OLD.match_lineup_id THEN
        NEW.captain = false;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbu_match_lineup_players BEFORE UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tau_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
     IF NEW.captain = true THEN
        UPDATE match_lineup_players
            SET captain = false
            WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
    END IF;

    PERFORM pick_captain(NEW.match_lineup_id);
    PERFORM pick_captain(OLD.match_lineup_id);

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tau_match_lineup_players AFTER UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tau_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tbid_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    status text;
    match_type text;
    lineup_count INT;
    _max_players_per_lineup INT;
BEGIN
    SELECT mo.type, m.status INTO match_type, status
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE ml.id = COALESCE(NEW.match_lineup_id, OLD.match_lineup_id);

    IF TG_OP = 'INSERT' THEN
        IF is_banned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)) THEN
            RAISE EXCEPTION 'Player is Currently Banned' USING ERRCODE = '22000';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        SELECT COUNT(*) INTO lineup_count
            FROM match_lineup_players
            WHERE match_lineup_id = OLD.match_lineup_id;

        IF ((status != 'PickingPlayers' AND status != 'Canceled') AND (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role')::text != 'admin') THEN
            SELECT get_match_type_min_players(match_type) INTO _max_players_per_lineup;

            IF (lineup_count - 1) >= _max_players_per_lineup THEN
                RETURN OLD;
            END IF;

            RAISE EXCEPTION 'Cannot remove players: not enough players in lineup' USING ERRCODE = '22000';
        END IF;

        RETURN OLD;
    ELSE
        select check_match_lineup_players_count(NEW) into lineup_count;

        IF lineup_count = 0 THEN
            NEW.captain = true;
        END IF;

        PERFORM check_match_lineup_players(NEW);

        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS tbid_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbid_match_lineup_players BEFORE INSERT OR DELETE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbid_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tad_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    captain_count INT;
    new_captain_id bigint;
BEGIN
    PERFORM pick_captain(OLD.match_lineup_id);

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tad_match_lineup_players AFTER DELETE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tad_match_lineup_players();

-- Queue parties for 5stack matches.
--
-- We already know who queued together — it is the lobby — so this is derived in
-- the database rather than posted by the API. Covers every path that fills a
-- lineup from a lobby (matchmaking, and web-created matches split out of the
-- creator's lobby by tai_match), with no external call.
--
-- Statement level with a transition table, not per row: the "is anyone else
-- from my lobby in this match" test needs the other players to already be
-- inserted, which is never true on the first row of a bulk insert. Matchmaking
-- inserts one statement per team, and the second recomputes the whole match, so
-- a lobby split across both lineups still resolves.
CREATE OR REPLACE FUNCTION public.assign_lobby_parties(_match_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only matches we ran ourselves. An imported match's parties come from the
    -- source's own queue data (the Valve reservation / FACEIT match room), and
    -- a lobby two of its players happen to share says nothing about how they
    -- queued for someone else's server.
    --
    -- This is not belt-and-braces: for an import the lineups are filled before
    -- the match row exists, so match_id is still NULL here and the loop below
    -- would skip it anyway. But that is an accident of insert ordering, and
    -- adding a player to an imported match later (an admin moving someone) has
    -- match_id set and would otherwise stamp a bogus lobby party.
    IF NOT EXISTS (
        SELECT 1
          FROM public.matches
         WHERE id = _match_id
           AND source = '5stack'
    ) THEN
        RETURN;
    END IF;

    UPDATE public.match_lineup_players mlp
       SET party_id = lp.lobby_id,
           party_source = 'lobby'
      FROM public.match_lineups ml,
           public.lobby_players lp
     WHERE ml.id = mlp.match_lineup_id
       AND ml.match_id = _match_id
       AND lp.steam_id = mlp.steam_id
       AND lp.status = 'Accepted'
       -- Never clobber a party the importer already resolved from Valve or
       -- FACEIT, and never rewrite one we have already set.
       AND mlp.party_id IS NULL
       -- A lobby only counts as a party when someone else from it is actually
       -- in this match. Without this, being in any lobby would tag you as
       -- partied on unrelated matches (tournaments, scrims) whose lineups come
       -- from a team roster.
       AND EXISTS (
           SELECT 1
             FROM public.match_lineup_players other
             JOIN public.match_lineups other_ml
               ON other_ml.id = other.match_lineup_id
             JOIN public.lobby_players other_lp
               ON other_lp.steam_id = other.steam_id
              AND other_lp.lobby_id = lp.lobby_id
              AND other_lp.status = 'Accepted'
            WHERE other_ml.match_id = _match_id
              AND other.steam_id IS DISTINCT FROM mlp.steam_id
       );
END;
$$;

CREATE OR REPLACE FUNCTION public.tai_match_lineup_players_parties() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_match_id uuid;
BEGIN
    FOR v_match_id IN
        SELECT DISTINCT ml.match_id
          FROM new_rows nr
          JOIN public.match_lineups ml ON ml.id = nr.match_lineup_id
         WHERE ml.match_id IS NOT NULL
    LOOP
        PERFORM public.assign_lobby_parties(v_match_id);
    END LOOP;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_lineup_players_parties ON public.match_lineup_players;
CREATE TRIGGER tai_match_lineup_players_parties
    AFTER INSERT ON public.match_lineup_players
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.tai_match_lineup_players_parties();
