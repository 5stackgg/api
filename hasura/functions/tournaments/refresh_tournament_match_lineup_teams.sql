DROP FUNCTION IF EXISTS public.refresh_tournament_match_lineup(public.matches, uuid, uuid);
DROP FUNCTION IF EXISTS public.refresh_tournament_match_lineup(public.matches, uuid, uuid, boolean);

-- Rows are re-seated IN PLACE: when a lineup's minimum equals its maximum
-- (Duel, or substitutes off) neither delete-then-insert nor insert-then-delete
-- gets past the guards on match_lineup_players. A re-seated row is reset to
-- what an insert would give the new player, and parties are assigned here
-- because tai_match_lineup_players_parties only fires on INSERT.
--
-- A banned player is never newly seated (tbid_match_lineup_players refuses),
-- but one who is already seated keeps the seat: a ban is not a roster change.
-- A player already seated on the other side of the match (an organizer's
-- stand-in) is not taken from there.
--
-- A lineup is never left below the minimum: when the roster cannot keep it
-- there (it counts a banned player, or one seated on the other side) the
-- lineup is left as it is and false is returned.
--
-- The lineup captain only moves when they left the lineup or when the
-- tournament captain was explicitly changed (_follow_captain), so a captain
-- picked by hand for check-in survives an unrelated roster edit.
CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup(
    _match public.matches,
    _match_lineup_id uuid,
    _tournament_team_id uuid,
    _follow_captain boolean
) RETURNS boolean
    LANGUAGE plpgsql
AS $$
DECLARE
    _captain_steam_id bigint;
    _lineup_captain bigint;
    _seated int;
    _min_players int;
    _desired bigint[];
    _vacated uuid[];
    _incoming bigint[];
    _index int;
BEGIN
    SELECT tt.captain_steam_id
    INTO _captain_steam_id
    FROM tournament_teams tt
    WHERE tt.id = _tournament_team_id;

    SELECT mlp.steam_id
    INTO _lineup_captain
    FROM match_lineup_players mlp
    WHERE mlp.match_lineup_id = _match_lineup_id
      AND mlp.captain;

    -- Same ordering and cap schedule_tournament_match() uses.
    SELECT COALESCE(array_agg(player_steam_id ORDER BY ord), ARRAY[]::bigint[])
    INTO _desired
    FROM (
        SELECT ttr.player_steam_id,
               row_number() OVER (
                   ORDER BY
                       CASE WHEN ttr.player_steam_id = _captain_steam_id THEN 0 ELSE 1 END,
                       CASE tr.status
                           WHEN 'Starter' THEN 1
                           WHEN 'Substitute' THEN 2
                           WHEN 'Benched' THEN 3
                           ELSE 4
                       END,
                       ttr.player_steam_id
               ) AS ord
        FROM tournament_team_roster ttr
        INNER JOIN tournament_teams tt
          ON tt.id = ttr.tournament_team_id
        INNER JOIN players p
          ON p.steam_id = ttr.player_steam_id
        LEFT JOIN team_roster tr
          ON tr.team_id = tt.team_id
         AND tr.player_steam_id = ttr.player_steam_id
        WHERE ttr.tournament_team_id = _tournament_team_id
          AND (
              NOT is_banned(p)
              OR EXISTS (
                  SELECT 1
                  FROM match_lineup_players seated
                  WHERE seated.match_lineup_id = _match_lineup_id
                    AND seated.steam_id = ttr.player_steam_id
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM match_lineup_players elsewhere
              WHERE elsewhere.match_lineup_id IN (_match.lineup_1_id, _match.lineup_2_id)
                AND elsewhere.match_lineup_id <> _match_lineup_id
                AND elsewhere.steam_id = ttr.player_steam_id
          )
        ORDER BY ord
        LIMIT match_max_players_per_lineup(_match)
    ) ranked;

    SELECT COUNT(*)
    INTO _seated
    FROM match_lineup_players mlp
    WHERE mlp.match_lineup_id = _match_lineup_id;

    _min_players := match_min_players_per_lineup(_match);

    IF cardinality(_desired) < _min_players AND cardinality(_desired) < _seated THEN
        RETURN false;
    END IF;

    SELECT COALESCE(array_agg(mlp.id ORDER BY mlp.steam_id NULLS LAST, mlp.id), ARRAY[]::uuid[])
    INTO _vacated
    FROM match_lineup_players mlp
    WHERE mlp.match_lineup_id = _match_lineup_id
      AND NOT COALESCE(mlp.steam_id = ANY(_desired), false);

    SELECT COALESCE(array_agg(d.steam_id ORDER BY d.ord), ARRAY[]::bigint[])
    INTO _incoming
    FROM unnest(_desired) WITH ORDINALITY AS d(steam_id, ord)
    WHERE NOT EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = _match_lineup_id
          AND mlp.steam_id = d.steam_id
    );

    FOR _index IN 1..LEAST(cardinality(_vacated), cardinality(_incoming)) LOOP
        UPDATE match_lineup_players
        SET steam_id = _incoming[_index],
            discord_id = NULL,
            placeholder_name = NULL,
            captain = false,
            checked_in = false,
            is_connected = false,
            party_id = NULL,
            party_source = NULL
        WHERE id = _vacated[_index];
    END LOOP;

    IF cardinality(_incoming) > cardinality(_vacated) THEN
        INSERT INTO match_lineup_players (match_lineup_id, steam_id)
        SELECT _match_lineup_id, d.steam_id
        FROM unnest(_incoming[cardinality(_vacated) + 1 :]) WITH ORDINALITY AS d(steam_id, ord)
        ORDER BY d.ord;
    END IF;

    IF cardinality(_vacated) > cardinality(_incoming) THEN
        DELETE FROM match_lineup_players
        WHERE id = ANY(_vacated[cardinality(_incoming) + 1 :]);
    END IF;

    IF LEAST(cardinality(_vacated), cardinality(_incoming)) > 0 THEN
        PERFORM assign_lobby_parties(_match.id);
    END IF;

    IF _captain_steam_id = ANY(_desired)
       AND (_follow_captain OR NOT COALESCE(_lineup_captain = ANY(_desired), false)) THEN
        UPDATE match_lineup_players
        SET captain = COALESCE(steam_id = _captain_steam_id, false)
        WHERE match_lineup_id = _match_lineup_id
          AND captain IS DISTINCT FROM COALESCE(steam_id = _captain_steam_id, false);
    END IF;

    RETURN true;
END;
$$;

DROP FUNCTION IF EXISTS public.refresh_tournament_match_lineup_teams(public.tournament_brackets);

-- Re-point an already-created tournament match's lineups at whatever teams the
-- bracket now holds. Needed when an organizer reassigns a winner: the bracket's
-- tournament_team_id_N is updated, but the downstream match already exists, so
-- its lineups would otherwise stay attached to the team that was advanced by
-- mistake. Only the side whose team changed is touched: the other side may
-- carry an organizer's hand edits.
--
-- Only touches matches that have not been played yet. Anything further along
-- has to go through the explicit reset/recreate flow instead.
CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup_teams(
    bracket public.tournament_brackets,
    previous public.tournament_brackets
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _match matches%ROWTYPE;
    _lineup RECORD;
BEGIN
    IF bracket.match_id IS NULL THEN
        RETURN;
    END IF;

    -- Shared lock so a match that starts concurrently is seen as started.
    SELECT * INTO _match
    FROM matches
    WHERE id = bracket.match_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Unplayed only. Canceled is included because reassignment is part of how
    -- organizers recover a mis-advanced bracket.
    IF _match.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled') THEN
        RETURN;
    END IF;

    FOR _lineup IN
        SELECT * FROM (VALUES
            (_match.lineup_1_id, bracket.tournament_team_id_1, previous.tournament_team_id_1),
            (_match.lineup_2_id, bracket.tournament_team_id_2, previous.tournament_team_id_2)
        ) AS l(match_lineup_id, tournament_team_id, previous_tournament_team_id)
    LOOP
        CONTINUE WHEN _lineup.match_lineup_id IS NULL
            OR _lineup.tournament_team_id IS NOT DISTINCT FROM _lineup.previous_tournament_team_id;

        UPDATE match_lineups ml
           SET team_id = tt.team_id
          FROM tournament_teams tt
         WHERE ml.id = _lineup.match_lineup_id
           AND tt.id = _lineup.tournament_team_id;

        CONTINUE WHEN _lineup.tournament_team_id IS NULL;

        -- Refused rather than left as it is: left alone, the lineup would keep
        -- seating the team that was moved out of this slot.
        IF NOT refresh_tournament_match_lineup(
            _match,
            _lineup.match_lineup_id,
            _lineup.tournament_team_id,
            false
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '22000',
                MESSAGE = 'The team cannot field the minimum lineup of '
                    || match_min_players_per_lineup(_match) || ' players for its next match';
        END IF;
    END LOOP;
END;
$$;
