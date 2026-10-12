-- Seats a tournament team's current roster in one lineup of a match that has
-- not been played, changing only what differs: players still wanted keep their
-- row (and their check-in), players no longer wanted give their row to an
-- incoming player, and only then is genuine surplus inserted or deleted.
--
-- Rows are re-seated IN PLACE rather than deleted and re-inserted: clearing a
-- lineup first trips the shared minimum-player guard on match_lineup_players
-- ("Cannot remove players: not enough players in lineup"). A re-seated row is
-- a different player, so it must not keep the previous player's check-in or
-- captaincy.
--
-- Banned players are left out: tbid_match_lineup_players refuses to seat them,
-- which would otherwise fail whatever roster write caused the refresh.
CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup(
    _match public.matches,
    _match_lineup_id uuid,
    _tournament_team_id uuid
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _captain_steam_id bigint;
    _desired bigint[];
    _vacated uuid[];
    _incoming bigint[];
    _index int;
BEGIN
    SELECT tt.captain_steam_id
    INTO _captain_steam_id
    FROM tournament_teams tt
    WHERE tt.id = _tournament_team_id;

    -- Same ordering and cap schedule_tournament_match() uses, so a
    -- refreshed lineup is indistinguishable from a freshly scheduled one.
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
          AND NOT is_banned(p)
        ORDER BY ord
        LIMIT match_max_players_per_lineup(_match)
    ) ranked;

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

    FOR _index IN 1..cardinality(_incoming) LOOP
        IF _index <= cardinality(_vacated) THEN
            UPDATE match_lineup_players
            SET steam_id = _incoming[_index],
                placeholder_name = NULL,
                checked_in = false,
                captain = false
            WHERE id = _vacated[_index];
        ELSE
            INSERT INTO match_lineup_players (match_lineup_id, steam_id)
            VALUES (_match_lineup_id, _incoming[_index]);
        END IF;
    END LOOP;

    IF cardinality(_vacated) > cardinality(_incoming) THEN
        DELETE FROM match_lineup_players
        WHERE id = ANY(_vacated[cardinality(_incoming) + 1 : cardinality(_vacated)]);
    END IF;

    -- tournament_teams.captain_steam_id is nullable; with no seated tournament
    -- captain, pick_captain has already kept exactly one lineup captain.
    IF _captain_steam_id = ANY(_desired) THEN
        UPDATE match_lineup_players
        SET captain = COALESCE(steam_id = _captain_steam_id, false)
        WHERE match_lineup_id = _match_lineup_id
          AND captain IS DISTINCT FROM COALESCE(steam_id = _captain_steam_id, false);
    END IF;
END;
$$;

-- Re-point an already-created tournament match's lineups at whatever teams the
-- bracket now holds. Needed when an organizer reassigns a winner: the bracket's
-- tournament_team_id_N is updated, but the downstream match already exists, so
-- its lineups would otherwise stay attached to the team that was advanced by
-- mistake.
--
-- Only touches matches that have not been played yet. Anything further along
-- has to go through the explicit reset/recreate flow instead.
CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup_teams(bracket public.tournament_brackets) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _match matches%ROWTYPE;
    _lineup RECORD;
BEGIN
    IF bracket.match_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO _match
    FROM matches
    WHERE id = bracket.match_id;

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
            (_match.lineup_1_id, bracket.tournament_team_id_1),
            (_match.lineup_2_id, bracket.tournament_team_id_2)
        ) AS l(match_lineup_id, tournament_team_id)
    LOOP
        CONTINUE WHEN _lineup.match_lineup_id IS NULL;

        UPDATE match_lineups ml
           SET team_id = tt.team_id
          FROM tournament_teams tt
         WHERE ml.id = _lineup.match_lineup_id
           AND tt.id = _lineup.tournament_team_id;

        CONTINUE WHEN _lineup.tournament_team_id IS NULL;

        PERFORM refresh_tournament_match_lineup(
            _match,
            _lineup.match_lineup_id,
            _lineup.tournament_team_id
        );
    END LOOP;
END;
$$;
