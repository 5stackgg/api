-- Owners demoted on their own roster before tbu_team_roster existed. The
-- rebalancing GUC keeps the roster cap trigger out of a role-only update.
SELECT set_config('fivestack.rebalancing', 'true', true);

UPDATE public.team_roster tr
   SET role = 'Admin'
  FROM public.teams t
 WHERE t.id = tr.team_id
   AND tr.player_steam_id = t.owner_steam_id
   AND tr.role <> 'Admin';

SELECT set_config('fivestack.rebalancing', 'false', true);
