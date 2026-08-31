-- The rating this tournament's format actually rates on: 2-per-lineup formats
-- run on the Wingman ladder, everything else on Competitive. Season handling
-- mirrors get_player_elo so the number that gates entry is the same number the
-- player sees on their profile.
CREATE OR REPLACE FUNCTION public.get_tournament_player_elo(_tournament_id uuid, _player_steam_id bigint)
RETURNS numeric
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _tournament public.tournaments;
    _player public.players;
    _team_size int;
    _elo_type text;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _player FROM public.players p WHERE p.steam_id = _player_steam_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    _team_size := COALESCE(
        public.tournament_min_players_per_lineup(_tournament),
        public.tournament_max_players_per_lineup(_tournament)
    );

    _elo_type := CASE WHEN _team_size = 2 THEN 'Wingman' ELSE 'Competitive' END;

    IF public.seasons_enabled() THEN
        RETURN public.get_player_season_elo_by_type(_player, _elo_type, public.get_active_season());
    END IF;

    RETURN public.get_player_elo_by_type(_player, _elo_type);
END;
$$;

-- Gates the player being ADDED, not the session doing the adding: a captain
-- fills a roster with other people, so checking only the actor leaves every
-- teammate ungated. Takes the tournament id rather than a row so a trigger can
-- call it from a child table without re-fetching the parent.
CREATE OR REPLACE FUNCTION public.player_meets_tournament_requirements(tournament_id uuid, player_steam_id bigint)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _tournament public.tournaments;
    _player_role text;
    _elo numeric;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = tournament_id;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    SELECT p.role INTO _player_role FROM public.players p WHERE p.steam_id = player_steam_id;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- Wrapping the stored role in a synthetic session keeps the ordering in
    -- is_above_role: an unknown role yields NULL there and is denied here.
    IF _tournament.min_role IS NOT NULL
       AND NOT COALESCE(
               public.is_above_role(
                   _tournament.min_role,
                   json_build_object('x-hasura-role', _player_role)
               ), false) THEN
        RETURN false;
    END IF;

    -- The tournaments half of the sanctions policy. Checked on the way IN only:
    -- this gate runs on roster and free-agent inserts, so a player who earns a
    -- tournament ban keeps the place they already hold rather than being pulled
    -- out of a bracket mid-run.
    IF public.player_sanction_expiry(player_steam_id, 'tournaments') > now() THEN
        RETURN false;
    END IF;

    IF _tournament.min_elo IS NULL AND _tournament.max_elo IS NULL THEN
        RETURN true;
    END IF;

    -- Never rated here yet: treat them as sitting on the ladder's starting ELO
    -- rather than excluding them, so a new account is not silently unenterable.
    _elo := COALESCE(public.get_tournament_player_elo(tournament_id, player_steam_id), 5000);

    IF _tournament.min_elo IS NOT NULL AND _elo < _tournament.min_elo THEN
        RETURN false;
    END IF;

    IF _tournament.max_elo IS NOT NULL AND _elo > _tournament.max_elo THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;

-- Computed-field shape of the above, so an insert `check` can gate on the
-- row's own target player. Lives in this file, below what it calls, because
-- apply() walks hasura/functions alphabetically and a LANGUAGE sql body is
-- resolved at CREATE time.
CREATE OR REPLACE FUNCTION public.tournament_team_roster_target_eligible(roster public.tournament_team_roster)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT public.player_meets_tournament_requirements(roster.tournament_id, roster.player_steam_id);
$$;
