-- Every player is_in_another_match answers true for, from one pass over the
-- active matches. The friends list asks it of each friend, so v_my_friends
-- reads this set once per poll rather than calling the function per friend.
CREATE OR REPLACE FUNCTION public.players_in_another_match()
RETURNS SETOF bigint
LANGUAGE sql
STABLE
AS $$
    SELECT mlp.steam_id
    FROM matches m
    JOIN match_lineup_players mlp
      ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE m.source <> 'practice'
      AND mlp.steam_id IS NOT NULL
      AND (
          m.status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer')
          OR (m.status = 'Live' AND NOT match_series_decided(m.id))
          OR (
              m.status = 'Scheduled'
              AND m.scheduled_at IS NOT NULL
              AND m.scheduled_at <= NOW() + INTERVAL '1 hour'
          )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM tournament_brackets tb
          INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
          INNER JOIN tournaments t ON t.id = ts.tournament_id
          WHERE tb.match_id = m.id
            AND t.status = 'Paused'
      );
$$;
