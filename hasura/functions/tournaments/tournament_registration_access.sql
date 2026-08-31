-- The single choke point every invite_only gate reduces to: has this player
-- been let into this tournament, either in their own right or through a team
-- they are allowed to register?
--
-- _team_id is what tells the two apart, and it is the whole reason a team invite
-- means what it says. tbi_tournament_team passes the team being registered;
-- tbi_tournament_free_agents and the computed field pass NULL, so an invited
-- team gets to enter as a team and its members do not each get a free-agent
-- slot out of it.
--
-- The 2-argument form has to be dropped explicitly rather than replaced: a
-- default-valued third parameter leaves both resolvable, and every existing call
-- site then fails as ambiguous (42725).
DROP FUNCTION IF EXISTS public.tournament_registration_unlocked(uuid, bigint);

CREATE OR REPLACE FUNCTION public.tournament_registration_unlocked(
    _tournament_id uuid,
    _player_steam_id bigint,
    _team_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournament_registration_unlocks u
        WHERE u.tournament_id = _tournament_id
          AND u.team_id IS NULL
          AND u.player_steam_id = _player_steam_id
    )
    -- Exactly the people public_tournament_teams.yaml already lets register a
    -- team: its owner, its captain, or a team_roster Admin.
    OR EXISTS (
        SELECT 1
        FROM public.tournament_registration_unlocks u
        JOIN public.teams t ON t.id = u.team_id
        WHERE u.tournament_id = _tournament_id
          AND u.team_id = _team_id
          AND (
              t.owner_steam_id = _player_steam_id
              OR t.captain_steam_id = _player_steam_id
              OR EXISTS (
                  SELECT 1
                  FROM public.team_roster tr
                  WHERE tr.team_id = t.id
                    AND tr.player_steam_id = _player_steam_id
                    AND tr.role = 'Admin'
              )
          )
    );
$$;

-- Computed-field form, so the join UI can tell "locked" from "already unlocked"
-- without being handed anything it could redeem. NULL team: this answers
-- whether the player themselves may enter, which is what the gate on the
-- tournament page is asking.
CREATE OR REPLACE FUNCTION public.tournament_registration_unlocked_for_session(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT NOT tournament.invite_only
        OR public.is_tournament_organizer(tournament, hasura_session)
        OR public.tournament_registration_unlocked(
               tournament.id,
               (hasura_session ->> 'x-hasura-user-id')::bigint
           );
$$;
