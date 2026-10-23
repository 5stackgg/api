-- The active matches the session's player is in a lineup of or organizes: the
-- rows every signed-in player's "my matches" subscription filters. Found from
-- the player's own lineups through partial indexes of active matches, so a poll
-- costs the player's own matches rather than an is_in_lineup call for every
-- active match on the site. Returning matches rows keeps each role's matches
-- permissions and computed fields.
CREATE OR REPLACE FUNCTION public.my_active_matches(hasura_session json)
RETURNS SETOF public.matches
LANGUAGE sql
STABLE
AS $$
    SELECT m.*
    FROM matches m
    WHERE m.status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers')
      AND m.id IN (
          SELECT x.id
          FROM matches x
          WHERE x.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
            AND x.status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers')
          UNION ALL
          SELECT x.id
          FROM match_lineup_players mlp
          JOIN matches x ON x.lineup_1_id = mlp.match_lineup_id
          WHERE mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
            AND x.status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers')
          UNION ALL
          SELECT x.id
          FROM match_lineup_players mlp
          JOIN matches x ON x.lineup_2_id = mlp.match_lineup_id
          WHERE mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
            AND x.status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers')
      )
$$;
