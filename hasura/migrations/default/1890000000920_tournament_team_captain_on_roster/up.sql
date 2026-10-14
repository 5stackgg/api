-- Check-in is now done by someone on the entry's roster, its captain among
-- them. Entries in tournaments still to start whose captain is not on the
-- roster (an owner who registered the team without playing on it) take one
-- who is, in the order ensure_tournament_team_captain picks.
UPDATE public.tournament_teams tt
SET captain_steam_id = (
    SELECT ttr.player_steam_id
    FROM public.tournament_team_roster ttr
    LEFT JOIN public.teams team ON team.id = tt.team_id
    LEFT JOIN public.team_roster tr
        ON tr.team_id = tt.team_id
       AND tr.player_steam_id = ttr.player_steam_id
    WHERE ttr.tournament_team_id = tt.id
    ORDER BY COALESCE(ttr.player_steam_id = team.captain_steam_id, false) DESC,
             COALESCE(ttr.player_steam_id = tt.owner_steam_id, false) DESC,
             COALESCE(tr.role = 'Admin', false) DESC,
             ttr.role = 'Admin' DESC,
             COALESCE(tr.status = 'Starter', false) DESC,
             ttr.player_steam_id
    LIMIT 1
)
FROM public.tournaments t
WHERE t.id = tt.tournament_id
  AND t.status IN ('Setup', 'RegistrationOpen', 'RegistrationClosed', 'CheckInReview')
  AND EXISTS (
      SELECT 1
      FROM public.tournament_team_roster ttr
      WHERE ttr.tournament_team_id = tt.id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM public.tournament_team_roster ttr
      WHERE ttr.tournament_team_id = tt.id
        AND ttr.player_steam_id = tt.captain_steam_id
  );
