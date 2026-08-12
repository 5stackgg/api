-- Re-point an already-created tournament match's lineups at whatever teams the
-- bracket now holds. Needed when an organizer reassigns a winner: the bracket's
-- tournament_team_id_N is updated, but the downstream match already exists, so
-- its lineups would otherwise stay attached to the team that was advanced by
-- mistake.
--
-- Only touches matches that have not been played yet. Anything further along
-- has to go through the explicit reset/recreate flow instead.
--
-- The roster is swapped IN PLACE rather than deleted and re-inserted: clearing a
-- lineup first trips the shared minimum-player guard on match_lineup_players
-- ("Cannot remove players: not enough players in lineup"), which would reject
-- the whole reassignment. Existing rows are re-pointed at the incoming players,
-- only genuine surplus is inserted, and only genuine surplus is deleted -- after
-- every desired player is already seated.
CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup_teams(bracket public.tournament_brackets) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _match matches%ROWTYPE;
    _lineup RECORD;
    _max_players_per_lineup int;
    _desired bigint[];
    _existing_ids uuid[];
    _captain_steam_id bigint;
    _index int;
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

    SELECT match_max_players_per_lineup(_match)
    INTO _max_players_per_lineup;

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

        SELECT tt.captain_steam_id
        INTO _captain_steam_id
        FROM tournament_teams tt
        WHERE tt.id = _lineup.tournament_team_id;

        -- Same ordering and cap schedule_tournament_match() uses, so a
        -- refreshed lineup is indistinguishable from a freshly scheduled one.
        SELECT array_agg(player_steam_id ORDER BY ord)
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
            LEFT JOIN team_roster tr
              ON tr.team_id = tt.team_id
             AND tr.player_steam_id = ttr.player_steam_id
            WHERE ttr.tournament_team_id = _lineup.tournament_team_id
            ORDER BY ord
            LIMIT _max_players_per_lineup
        ) ranked;

        _desired := COALESCE(_desired, ARRAY[]::bigint[]);

        SELECT array_agg(id ORDER BY steam_id NULLS LAST)
        INTO _existing_ids
        FROM match_lineup_players
        WHERE match_lineup_id = _lineup.match_lineup_id;

        _existing_ids := COALESCE(_existing_ids, ARRAY[]::uuid[]);

        -- Seat every desired player, reusing a row where one is free.
        FOR _index IN 1..COALESCE(array_length(_desired, 1), 0) LOOP
            IF _index <= COALESCE(array_length(_existing_ids, 1), 0) THEN
                UPDATE match_lineup_players
                SET steam_id = _desired[_index],
                    placeholder_name = NULL,
                    captain = (_desired[_index] = _captain_steam_id)
                WHERE id = _existing_ids[_index];
            ELSE
                INSERT INTO match_lineup_players (match_lineup_id, steam_id, captain)
                VALUES (
                    _lineup.match_lineup_id,
                    _desired[_index],
                    _desired[_index] = _captain_steam_id
                );
            END IF;
        END LOOP;

        -- Now that the desired roster is fully seated, drop the leftovers.
        IF COALESCE(array_length(_existing_ids, 1), 0) > COALESCE(array_length(_desired, 1), 0) THEN
            DELETE FROM match_lineup_players
            WHERE id = ANY(
                _existing_ids[COALESCE(array_length(_desired, 1), 0) + 1 :
                              array_length(_existing_ids, 1)]
            );
        END IF;
    END LOOP;
END;
$$;
