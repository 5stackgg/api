-- Season rollover: clone a finished season's full configuration (format,
-- windows, weeks pattern, match options) into a fresh Setup season, with
-- every timestamp shifted forward by whole weeks so weekday/time-of-day are
-- preserved. Admins adjust dates before opening registration.
CREATE OR REPLACE FUNCTION public.clone_league_season(
    _league_season_id uuid,
    hasura_session json
)
RETURNS SETOF public.league_seasons
LANGUAGE plpgsql
AS $$
DECLARE
    season public.league_seasons;
    _new_season_id uuid;
    _shift interval;
    _options_id uuid;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = _league_season_id;
    IF season IS NULL THEN
        RAISE EXCEPTION 'Season not found' USING ERRCODE = '22000';
    END IF;

    IF NOT public.is_league_admin_for_session(hasura_session) THEN
        RAISE EXCEPTION 'Must be a league admin' USING ERRCODE = '22000';
    END IF;

    -- Shift forward past NOW() in whole weeks, keeping weekday/time-of-day.
    _shift := make_interval(weeks => GREATEST(
        CEIL(EXTRACT(EPOCH FROM (NOW() - COALESCE(season.starts_at, NOW()))) / 604800.0)::int + 1,
        1
    ));

    _options_id := public.clone_match_options(season.match_options_id);

    -- name/season_number are auto-assigned by tbi_league_seasons.
    INSERT INTO public.league_seasons (
        created_by_steam_id, status,
        signup_opens_at, signup_closes_at, starts_at, roster_lock_at,
        match_weeks_count, games_per_week, playoff_seats,
        direct_promote_count, relegation_up_count, relegation_down_count, direct_relegate_count,
        match_options_id, default_best_of, playoff_best_of,
        week_best_of, playoff_round_best_of,
        auto_regular_season_format, regular_season_stage_type, playoff_stage_type, playoff_third_place_match,
        min_roster_size, max_roster_size
    )
    VALUES (
        (hasura_session ->> 'x-hasura-user-id')::bigint, 'Setup',
        season.signup_opens_at + _shift, season.signup_closes_at + _shift,
        season.starts_at + _shift, season.roster_lock_at + _shift,
        season.match_weeks_count, season.games_per_week, season.playoff_seats,
        season.direct_promote_count, season.relegation_up_count, season.relegation_down_count, season.direct_relegate_count,
        _options_id, season.default_best_of, season.playoff_best_of,
        season.week_best_of, season.playoff_round_best_of,
        season.auto_regular_season_format, season.regular_season_stage_type, season.playoff_stage_type, season.playoff_third_place_match,
        season.min_roster_size, season.max_roster_size
    )
    RETURNING id INTO _new_season_id;

    INSERT INTO public.league_match_weeks (league_season_id, week_number, opens_at, closes_at, default_match_at)
    SELECT _new_season_id, week_number, opens_at + _shift, closes_at + _shift, default_match_at + _shift
    FROM public.league_match_weeks
    WHERE league_season_id = _league_season_id;

    RETURN QUERY SELECT * FROM public.league_seasons WHERE id = _new_season_id;
END;
$$;
