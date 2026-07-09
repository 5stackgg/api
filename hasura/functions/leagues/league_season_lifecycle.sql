-- League season lifecycle: materializes one tournament per (season, division)
-- when a season goes Live, and finishes the season once all division
-- tournaments conclude.

-- Transforms a league-level best-of map keyed by week/round number
-- ({"5": 3}) into the tournament stage settings shape get_bracket_best_of
-- resolves ({"round_best_of": {"WB:5": 3}}). NULL when nothing is configured.
CREATE OR REPLACE FUNCTION public.league_round_best_of_settings(_map jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN _map IS NULL OR _map = '{}'::jsonb THEN NULL
        ELSE jsonb_build_object(
            'round_best_of',
            (
                SELECT jsonb_object_agg('WB:' || key, value)
                FROM jsonb_each(_map)
            )
        )
    END;
$$;

-- Playoff best-of maps already use the native stage round keys
-- ("WB:1", "LB:2", "GF") so double-elimination rounds and the grand final
-- are addressable exactly like tournament stages.
CREATE OR REPLACE FUNCTION public.league_playoff_best_of_settings(_map jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN _map IS NULL OR _map = '{}'::jsonb THEN NULL
        ELSE jsonb_build_object('round_best_of', _map)
    END;
$$;

-- Match options are forced to admin mode so brackets stay dormant until the two
-- teams agree on a time (or the weekly default kicks in).
CREATE OR REPLACE FUNCTION public.start_league_season(_league_season_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    season public.league_seasons;
    _organizer_steam_id bigint;
    division RECORD;
    team RECORD;
    _team_count int;
    _options_id uuid;
    _tournament_id uuid;
    _rr_stage_id uuid;
    _tournament_team_id uuid;
    _seed int;
    _total_rounds int;
    _full_rr_rounds int;
    _stage_type text;
    _effective_rounds int;
    _max_effective_rounds int := 0;
    _weeks_needed int;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = _league_season_id;
    IF season IS NULL THEN
        RAISE EXCEPTION 'League season % not found', _league_season_id USING ERRCODE = '22000';
    END IF;

    IF season.match_options_id IS NULL THEN
        RAISE EXCEPTION 'League season has no match options template' USING ERRCODE = '22000';
    END IF;

    -- The season creator organizes the division tournaments; fall back to any
    -- administrator if that player is gone.
    _organizer_steam_id := COALESCE(
        season.created_by_steam_id,
        (SELECT steam_id FROM public.players WHERE role = 'administrator' ORDER BY steam_id LIMIT 1)
    );

    FOR division IN
        SELECT lsd.id AS league_season_division_id, ld.id, ld.name, ld.tier
        FROM public.league_season_divisions lsd
        JOIN public.league_divisions ld ON ld.id = lsd.league_division_id
        WHERE lsd.league_season_id = season.id
          AND lsd.tournament_id IS NULL
        ORDER BY ld.tier
    LOOP
        SELECT COUNT(*) INTO _team_count
        FROM public.league_team_seasons lts
        WHERE lts.league_season_id = season.id
          AND lts.assigned_division_id = division.id
          AND lts.status = 'Approved';

        -- The tournament machinery requires at least 4 teams per group in the
        -- opening stage; smaller divisions cannot run.
        IF _team_count < 4 THEN
            RAISE NOTICE 'start_league_season: division % has % approved teams (minimum 4), skipping', division.name, _team_count;
            CONTINUE;
        END IF;

        -- Keep the division tournament's lineup cap in step with the roster
        -- size so a full roster (up to max_roster_size) is never rejected as
        -- "too many players": substitutes = max_roster_size - starters.
        _options_id := public.clone_match_options(season.match_options_id);
        UPDATE public.match_options mo
        SET match_mode = 'admin',
            best_of = season.default_best_of,
            number_of_substitutes = GREATEST(
                COALESCE(season.max_roster_size, public.team_max_roster_size())
                    - public.get_match_type_min_players(mo.type),
                0
            )
        WHERE mo.id = _options_id;

        INSERT INTO public.tournaments (name, description, start, organizer_steam_id, status, match_options_id, auto_start, scheduling_mode)
        VALUES (
            season.name || ' — ' || division.name,
            'League division play for ' || season.name,
            COALESCE(season.starts_at, NOW()),
            _organizer_steam_id,
            'Setup',
            _options_id,
            false,
            'negotiated'
        )
        RETURNING id INTO _tournament_id;

        -- Pick the regular-season format. Auto: a full round robin (everyone
        -- plays everyone; N-1 rounds even / N odd) when it fits the season's
        -- rounds, otherwise a Swiss GROUP (pair by record, no elimination — odd
        -- fields get a rotating bye). Manual uses regular_season_stage_type.
        _total_rounds := season.match_weeks_count * COALESCE(season.games_per_week, 1);
        _full_rr_rounds := CASE WHEN _team_count % 2 = 0 THEN _team_count - 1 ELSE _team_count END;
        IF COALESCE(season.auto_regular_season_format, true) THEN
            IF _full_rr_rounds > _total_rounds THEN
                _stage_type := 'Swiss';
            ELSE
                _stage_type := 'RoundRobin';
            END IF;
        ELSE
            _stage_type := season.regular_season_stage_type;
        END IF;

        -- Rounds the stage actually plays: a round robin runs its natural length
        -- (capped by the weeks), Swiss uses every round. This is what the
        -- scheduling windows are limited to, so a short round robin doesn't stamp
        -- windows on empty trailing weeks.
        IF _stage_type = 'RoundRobin' THEN
            _effective_rounds := LEAST(_full_rr_rounds, _total_rounds);
        ELSE
            _effective_rounds := _total_rounds;
        END IF;

        _max_effective_rounds := GREATEST(_max_effective_rounds, _effective_rounds);

        -- RoundRobin is capped to max_rounds (a no-op when the full RR already
        -- fits); Swiss GROUP plays exactly max_rounds rounds. Both rank the whole
        -- field in one table and feed the playoff the same way.
        INSERT INTO public.tournament_stages (tournament_id, type, "order", min_teams, max_teams, groups, default_best_of, max_rounds, swiss_no_elimination, settings)
        VALUES (_tournament_id, _stage_type, 1, 4, _team_count, 1, season.default_best_of,
                _effective_rounds,
                _stage_type = 'Swiss',
                public.league_round_best_of_settings(season.week_best_of))
        RETURNING id INTO _rr_stage_id;

        IF season.playoff_seats >= 2 THEN
            INSERT INTO public.tournament_stages (tournament_id, type, "order", min_teams, max_teams, groups, default_best_of, third_place_match, settings)
            VALUES (_tournament_id, season.playoff_stage_type, 2, 2, LEAST(season.playoff_seats, _team_count), 1, season.playoff_best_of,
                    season.playoff_stage_type = 'SingleElimination' AND season.playoff_third_place_match,
                    public.league_playoff_best_of_settings(season.playoff_round_best_of));
        END IF;

        _seed := 0;
        FOR team IN
            SELECT lts.id AS league_team_season_id,
                   lts.captain_steam_id AS registered_captain_steam_id,
                   lt.team_id,
                   t.name AS league_team_name,
                   t.owner_steam_id,
                   t.captain_steam_id AS team_captain_steam_id
            FROM public.league_team_seasons lts
            JOIN public.league_teams lt ON lt.id = lts.league_team_id
            JOIN public.teams t ON t.id = lt.team_id
            WHERE lts.league_season_id = season.id
              AND lts.assigned_division_id = division.id
              AND lts.status = 'Approved'
            ORDER BY lts.seed ASC NULLS LAST, lts.created_at ASC
        LOOP
            _seed := _seed + 1;

            INSERT INTO public.tournament_teams (tournament_id, team_id, name, owner_steam_id, captain_steam_id, eligible_at, seed)
            VALUES (
                _tournament_id,
                team.team_id,
                team.league_team_name,
                team.owner_steam_id,
                COALESCE(team.registered_captain_steam_id, team.team_captain_steam_id, team.owner_steam_id),
                NOW(),
                _seed
            )
            RETURNING id INTO _tournament_team_id;

            UPDATE public.league_team_seasons
            SET tournament_team_id = _tournament_team_id
            WHERE id = team.league_team_season_id;

            INSERT INTO public.tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
            SELECT _tournament_team_id, ltr.player_steam_id, _tournament_id, 'Member'
            FROM public.league_team_rosters ltr
            WHERE ltr.league_team_season_id = team.league_team_season_id
              AND ltr.removed_at IS NULL
            ON CONFLICT DO NOTHING;
        END LOOP;

        UPDATE public.league_season_divisions
        SET tournament_id = _tournament_id
        WHERE id = division.league_season_division_id;

        -- Fires tau_tournaments: generates the bracket skeleton (RoundRobin is
        -- already capped at max_rounds, so no post-truncation), assigns seeds
        -- and fills teams. Admin-mode options + negotiated scheduling keep every
        -- bracket dormant until a time is agreed.
        UPDATE public.tournaments SET status = 'Live' WHERE id = _tournament_id;

        -- Give the regular-season rounds their scheduling windows from the
        -- season's match weeks. With games_per_week > 1 a week hosts several
        -- rounds: round = (week-1)*gpw + slot, staggered a few days apart.
        INSERT INTO public.tournament_stage_windows (tournament_stage_id, round, opens_at, closes_at, default_match_at)
        SELECT _rr_stage_id,
               (lmw.week_number - 1) * COALESCE(season.games_per_week, 1) + slot,
               lmw.opens_at,
               lmw.closes_at,
               LEAST(
                   lmw.default_match_at + ((slot - 1) * INTERVAL '3 days'),
                   COALESCE(lmw.closes_at, lmw.default_match_at + ((slot - 1) * INTERVAL '3 days'))
               )
        FROM public.league_match_weeks lmw
        CROSS JOIN generate_series(1, COALESCE(season.games_per_week, 1)) AS slot
        WHERE lmw.league_season_id = season.id
          -- Only the weeks the stage actually uses; a short round robin leaves
          -- the trailing weeks free.
          AND (lmw.week_number - 1) * COALESCE(season.games_per_week, 1) + slot <= _effective_rounds
        ON CONFLICT (tournament_stage_id, round) DO NOTHING;
    END LOOP;

    -- Auto-shorten the season to the weeks actually used. Weeks are generated up
    -- front from match_weeks_count before team counts are known; a short round
    -- robin (or any format needing fewer rounds than weeks) leaves empty trailing
    -- weeks. Drop the surplus weeks and shrink match_weeks_count to match so the
    -- schedule stops at the last real round and a rollover clones the right size.
    IF _max_effective_rounds > 0 THEN
        _weeks_needed := CEIL(_max_effective_rounds::numeric / COALESCE(season.games_per_week, 1));

        DELETE FROM public.league_match_weeks
        WHERE league_season_id = season.id
          AND week_number > _weeks_needed;

        IF _weeks_needed < season.match_weeks_count THEN
            UPDATE public.league_seasons
            SET match_weeks_count = _weeks_needed
            WHERE id = season.id;
        END IF;
    END IF;
END;
$$;

-- Finish a league season once every division tournament is done, then compute
-- promotion/relegation movements for admin review.
CREATE OR REPLACE FUNCTION public.finish_league_season(_league_season_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _unfinished int;
BEGIN
    SELECT COUNT(*) INTO _unfinished
    FROM public.league_season_divisions lsd
    JOIN public.tournaments t ON t.id = lsd.tournament_id
    WHERE lsd.league_season_id = _league_season_id
      AND t.status NOT IN ('Finished', 'Cancelled', 'CancelledMinTeams');

    IF _unfinished > 0 THEN
        RAISE EXCEPTION 'League season still has % unfinished division tournaments', _unfinished USING ERRCODE = '22000';
    END IF;

    PERFORM public.compute_league_season_movements(_league_season_id);
    -- Materialize the cross-division relegation playoffs; the RelegationUp/Down
    -- movements stay provisional until each playoff resolves.
    PERFORM public.create_league_relegation_playoffs(_league_season_id);
END;
$$;

-- Restart a cancelled season: tear down its (cancelled) division/playoff
-- tournaments and re-materialize them from the same Approved team seasons,
-- reviving the season to Live. Recovery path when a season was cancelled by
-- mistake — teams, divisions, rosters and match weeks are all preserved.
CREATE OR REPLACE FUNCTION public.restart_league_season(
    _league_season_id uuid,
    hasura_session json
)
RETURNS SETOF public.league_seasons
LANGUAGE plpgsql
AS $$
DECLARE
    season public.league_seasons;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = _league_season_id;
    IF season IS NULL THEN
        RAISE EXCEPTION 'Season not found' USING ERRCODE = '22000';
    END IF;

    IF NOT public.is_league_admin_for_session(hasura_session) THEN
        RAISE EXCEPTION 'Must be a league admin' USING ERRCODE = '22000';
    END IF;

    IF season.status != 'Canceled' THEN
        RAISE EXCEPTION 'Only a canceled season can be restarted' USING ERRCODE = '22000';
    END IF;

    -- Bypass the league-ownership guard on tbd_tournaments for the teardown.
    PERFORM set_config('fivestack.league_cascade', 'true', true);

    -- Detach teams from the old cancelled rosters first, then drop the cancelled
    -- tournaments (their matches were already removed on cancel). Deleting the
    -- shells clears stages/teams/rosters; the FK nulls division/playoff links.
    UPDATE public.league_team_seasons
    SET tournament_team_id = NULL
    WHERE league_season_id = _league_season_id;

    DELETE FROM public.tournaments
    WHERE id IN (
        SELECT tournament_id FROM public.league_season_divisions
        WHERE league_season_id = _league_season_id AND tournament_id IS NOT NULL
        UNION
        SELECT tournament_id FROM public.league_relegation_playoffs
        WHERE league_season_id = _league_season_id AND tournament_id IS NOT NULL
    );

    UPDATE public.league_season_divisions
    SET tournament_id = NULL
    WHERE league_season_id = _league_season_id;

    DELETE FROM public.league_relegation_playoffs WHERE league_season_id = _league_season_id;
    DELETE FROM public.league_team_movements WHERE league_season_id = _league_season_id;

    -- Revive to Live; tau_league_seasons re-runs start_league_season, which
    -- rebuilds the division tournaments from the same Approved team seasons.
    PERFORM set_config('fivestack.league_restart', 'true', true);
    UPDATE public.league_seasons SET status = 'Live' WHERE id = _league_season_id;
    PERFORM set_config('fivestack.league_restart', 'false', true);

    PERFORM set_config('fivestack.league_cascade', 'false', true);

    RETURN QUERY SELECT * FROM public.league_seasons WHERE id = _league_season_id;
END;
$$;
