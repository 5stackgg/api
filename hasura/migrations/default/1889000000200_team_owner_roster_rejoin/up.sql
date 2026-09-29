-- Teams from before the captain column was checked against the roster still
-- name an owner who had left as captain. Lineup auto-fill picks the captain
-- first, so it goes before that owner is back on the roster.
UPDATE public.teams t
   SET captain_steam_id = NULL
 WHERE t.captain_steam_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1
         FROM public.team_roster tr
        WHERE tr.team_id = t.id
          AND tr.player_steam_id = t.captain_steam_id
   );

-- Owners who left their own roster before tbd_team_roster existed.
-- tbi_team_roster makes the owner an Admin; Benched keeps someone who chose to
-- leave out of the starter and substitute slots. On an organisation team the
-- new roster row also makes the owner an organizer of every tournament that
-- team is linked to.
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
