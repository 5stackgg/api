-- Owners who left their own roster before tbd_team_roster existed. tbi_team_roster
-- makes the owner an Admin, and Benched is outside the status caps, so this never
-- bumps a starter or substitute. On an organisation team the new roster row also
-- makes the owner an organizer of every tournament that team is linked to.
INSERT INTO public.team_roster (team_id, player_steam_id, status)
SELECT t.id, t.owner_steam_id, 'Benched'
  FROM public.teams t
 WHERE t.owner_steam_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1
         FROM public.team_roster tr
        WHERE tr.team_id = t.id
          AND tr.player_steam_id = t.owner_steam_id
   );
