-- Roster sizing is a team-wide setting (public.settings); seasons may still
-- carry an explicit override in their own column.
CREATE OR REPLACE FUNCTION public.team_max_roster_size() RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (SELECT NULLIF(value, '')::int FROM public.settings
         WHERE name = 'public.team_max_roster_size'),
        7
    );
$$;

CREATE OR REPLACE FUNCTION public.team_min_roster_size() RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (SELECT NULLIF(value, '')::int FROM public.settings
         WHERE name = 'public.team_min_roster_size'),
        5
    );
$$;

-- Substitute count is a team default (starters are always 5).
CREATE OR REPLACE FUNCTION public.team_max_subs() RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (SELECT NULLIF(value, '')::int FROM public.settings
         WHERE name = 'public.team_max_subs'),
        2
    );
$$;

-- There is a single global league, so managing it is a platform-administrator
-- capability rather than a per-league grant.
CREATE OR REPLACE FUNCTION public.is_league_season_admin(
    league_season public.league_seasons,
    hasura_session json
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator');
$$;

CREATE OR REPLACE FUNCTION public.is_league_admin_for_session(
    hasura_session json
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator');
$$;

CREATE OR REPLACE FUNCTION public.league_season_is_roster_locked(
    league_season public.league_seasons
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    -- A season without an explicit lock date locks at kickoff.
    SELECT CASE
        WHEN league_season.roster_lock_at IS NOT NULL
            THEN NOW() >= league_season.roster_lock_at
        ELSE league_season.status IN ('Live', 'Playoffs')
    END;
$$;

CREATE OR REPLACE FUNCTION public.manages_team(
    _team_id uuid,
    _steam_id bigint
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.teams t
        WHERE t.id = _team_id
          AND (
            t.owner_steam_id = _steam_id
            OR t.captain_steam_id = _steam_id
            OR EXISTS (
                SELECT 1 FROM public.team_roster tr
                WHERE tr.team_id = t.id
                  AND tr.player_steam_id = _steam_id
                  AND tr.role = 'Admin'
            )
          )
    );
$$;

CREATE OR REPLACE FUNCTION public.can_register_for_league_season(
    league_season public.league_seasons,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint;
BEGIN
    _steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF league_season.status != 'RegistrationOpen' THEN
        RETURN false;
    END IF;

    IF league_season.signup_opens_at IS NOT NULL AND NOW() < league_season.signup_opens_at THEN
        RETURN false;
    END IF;

    IF league_season.signup_closes_at IS NOT NULL AND NOW() >= league_season.signup_closes_at THEN
        RETURN false;
    END IF;

    -- Caller must manage at least one team that is not already registered this season.
    RETURN EXISTS (
        SELECT 1
        FROM public.teams t
        WHERE public.manages_team(t.id, _steam_id)
          AND NOT EXISTS (
            SELECT 1
            FROM public.league_team_seasons lts
            JOIN public.league_teams lt ON lt.id = lts.league_team_id
            WHERE lts.league_season_id = league_season.id
              AND lt.team_id = t.id
              AND lts.status != 'Withdrawn'
          )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.league_season_my_registration(
    league_season public.league_seasons,
    hasura_session json
) RETURNS SETOF public.league_team_seasons
LANGUAGE sql
STABLE
AS $$
    SELECT lts.*
    FROM public.league_team_seasons lts
    JOIN public.league_teams lt ON lt.id = lts.league_team_id
    WHERE lts.league_season_id = league_season.id
      AND (
        public.manages_team(lt.team_id, (hasura_session ->> 'x-hasura-user-id')::bigint)
        OR EXISTS (
            SELECT 1 FROM public.league_team_rosters ltr
            WHERE ltr.league_team_season_id = lts.id
              AND ltr.player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
              AND ltr.removed_at IS NULL
        )
      );
$$;
