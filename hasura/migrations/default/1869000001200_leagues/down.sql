-- Functions/views loaded from hasura/{functions,views} depend on these tables
-- (composite argument and row-type returns), so drop them first and cascade the rest.
DROP VIEW IF EXISTS public.v_league_season_player_stats;
DROP VIEW IF EXISTS public.v_league_division_standings;

DROP FUNCTION IF EXISTS public.league_season_my_registration(public.league_seasons, json);
DROP FUNCTION IF EXISTS public.can_register_for_league_season(public.league_seasons, json);
DROP FUNCTION IF EXISTS public.league_season_is_roster_locked(public.league_seasons);
DROP FUNCTION IF EXISTS public.is_league_season_admin(public.league_seasons, json);
DROP FUNCTION IF EXISTS public.is_league_admin_for_session(json);
DROP FUNCTION IF EXISTS public.remove_league_team_from_season(uuid, json);
DROP FUNCTION IF EXISTS public.clone_league_season(uuid, json);
DROP FUNCTION IF EXISTS public.restart_league_season(uuid, json);
DROP FUNCTION IF EXISTS public.finish_league_season(uuid);
DROP FUNCTION IF EXISTS public.start_league_season(uuid);
DROP FUNCTION IF EXISTS public.league_playoff_best_of_settings(jsonb);
DROP FUNCTION IF EXISTS public.league_round_best_of_settings(jsonb);
DROP FUNCTION IF EXISTS public.league_award_forfeit(uuid, uuid, json);
DROP FUNCTION IF EXISTS public.apply_league_default_schedules();
DROP FUNCTION IF EXISTS public.league_bracket_match_week(uuid);
DROP FUNCTION IF EXISTS public.tau_league_relegation_playoff() CASCADE;
DROP FUNCTION IF EXISTS public.resolve_league_relegation_playoff(uuid);
DROP FUNCTION IF EXISTS public.create_league_relegation_playoffs(uuid);
DROP FUNCTION IF EXISTS public.approve_league_season_movements(uuid, json);
DROP FUNCTION IF EXISTS public.compute_league_season_movements(uuid);
DROP FUNCTION IF EXISTS public.reorder_league_divisions(uuid[], json);
DROP FUNCTION IF EXISTS public.renumber_league_divisions();
DROP FUNCTION IF EXISTS public.enforce_min_active_league_divisions() CASCADE;
DROP FUNCTION IF EXISTS public.is_league_tournament(uuid);

DROP FUNCTION IF EXISTS public.tbi_league_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tbu_league_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tau_league_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tbd_league_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tad_league_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tbi_league_team_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tbu_league_team_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tau_league_team_seasons() CASCADE;
DROP FUNCTION IF EXISTS public.tbi_league_team_rosters() CASCADE;
DROP FUNCTION IF EXISTS public.tbu_league_team_rosters() CASCADE;
DROP FUNCTION IF EXISTS public.tad_league_team_rosters() CASCADE;
DROP FUNCTION IF EXISTS public.taiu_league_team_rosters() CASCADE;
DROP FUNCTION IF EXISTS public.tbi_league_scheduling_proposals() CASCADE;
DROP FUNCTION IF EXISTS public.tbu_league_scheduling_proposals() CASCADE;
DROP FUNCTION IF EXISTS public.tau_league_scheduling_proposals() CASCADE;
DROP FUNCTION IF EXISTS public.tbi_league_match_lineup_players() CASCADE;
DROP FUNCTION IF EXISTS public.tau_league_match_weeks() CASCADE;

-- Drop before tournament_stage_windows: tournament_bracket_window RETURNS that
-- composite type, so the table cannot be dropped while it exists.
DROP FUNCTION IF EXISTS public.apply_tournament_default_schedules();
DROP FUNCTION IF EXISTS public.tournament_bracket_window(uuid);
DROP FUNCTION IF EXISTS public.create_swiss_bye_bracket(uuid, int, uuid, numeric);

DROP TABLE IF EXISTS public.league_relegation_playoffs CASCADE;
DROP TABLE IF EXISTS public.league_team_movements CASCADE;
DROP TABLE IF EXISTS public.league_scheduling_proposals CASCADE;
DROP TABLE IF EXISTS public.league_season_divisions CASCADE;
DROP TABLE IF EXISTS public.league_team_rosters CASCADE;
DROP TABLE IF EXISTS public.league_team_seasons CASCADE;
DROP TABLE IF EXISTS public.league_teams CASCADE;
DROP TABLE IF EXISTS public.league_match_weeks CASCADE;
DROP TABLE IF EXISTS public.league_seasons CASCADE;
DROP TABLE IF EXISTS public.league_divisions CASCADE;
DROP TABLE IF EXISTS public.e_league_movement_types CASCADE;
DROP TABLE IF EXISTS public.e_league_proposal_statuses CASCADE;
DROP TABLE IF EXISTS public.e_league_registration_statuses CASCADE;
DROP TABLE IF EXISTS public.e_league_season_statuses CASCADE;

DROP TABLE IF EXISTS public.tournament_stage_windows;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_scheduling_mode_check;
ALTER TABLE public.tournaments DROP COLUMN IF EXISTS scheduling_mode;
ALTER TABLE public.tournament_stages DROP COLUMN IF EXISTS swiss_no_elimination;
ALTER TABLE public.tournament_stages DROP COLUMN IF EXISTS max_rounds;

DELETE FROM public.notifications WHERE type IN (
    'LeagueProposalReceived', 'LeagueProposalAccepted', 'LeagueProposalDeclined',
    'LeagueMatchUnscheduled', 'LeagueRegistrationDecision', 'LeagueRosterUndersized'
);
DELETE FROM public.e_notification_types WHERE value IN (
    'LeagueProposalReceived', 'LeagueProposalAccepted', 'LeagueProposalDeclined',
    'LeagueMatchUnscheduled', 'LeagueRegistrationDecision', 'LeagueRosterUndersized'
);
DELETE FROM public.settings WHERE name = 'public.leagues_enabled';
