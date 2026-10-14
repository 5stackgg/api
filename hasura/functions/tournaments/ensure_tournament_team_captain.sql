-- Check-in is the captain's, and only someone on the entry's roster can do it,
-- so a captain who is not on the roster hands the captaincy to someone who is:
-- the team's own captain, then its owner, then a team or roster Admin, then a
-- starter. A banned player is never picked. Nobody seated yet leaves it as is
-- for the next roster write to settle.
CREATE OR REPLACE FUNCTION public.ensure_tournament_team_captain(_tournament_team_id uuid)
RETURNS void
LANGUAGE sql
AS $$
    UPDATE public.tournament_teams tt
    SET captain_steam_id = heir.player_steam_id
    FROM (
        SELECT ttr.player_steam_id
        FROM public.tournament_teams entry
        INNER JOIN public.tournament_team_roster ttr ON ttr.tournament_team_id = entry.id
        INNER JOIN public.players p ON p.steam_id = ttr.player_steam_id
        LEFT JOIN public.teams t ON t.id = entry.team_id
        LEFT JOIN public.team_roster tr
            ON tr.team_id = entry.team_id
           AND tr.player_steam_id = ttr.player_steam_id
        WHERE entry.id = _tournament_team_id
          AND NOT public.is_banned(p)
        ORDER BY COALESCE(ttr.player_steam_id = t.captain_steam_id, false) DESC,
                 COALESCE(ttr.player_steam_id = entry.owner_steam_id, false) DESC,
                 COALESCE(tr.role = 'Admin', false) DESC,
                 ttr.role = 'Admin' DESC,
                 COALESCE(tr.status = 'Starter', false) DESC,
                 ttr.player_steam_id
        LIMIT 1
    ) heir
    WHERE tt.id = _tournament_team_id
      AND tt.captain_steam_id IS DISTINCT FROM heir.player_steam_id
      AND NOT EXISTS (
          SELECT 1
          FROM public.tournament_team_roster ttr
          WHERE ttr.tournament_team_id = tt.id
            AND ttr.player_steam_id = tt.captain_steam_id
      );
$$;
