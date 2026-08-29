DROP TABLE IF EXISTS public.tournament_leaderboard_entries;

DROP INDEX IF EXISTS public.idx_tournament_free_agents_tournament_status;

DROP TABLE IF EXISTS public.tournament_free_agents;

ALTER TABLE public.tournament_team_roster
    DROP COLUMN IF EXISTS checked_in_at;

ALTER TABLE public.tournament_teams
    DROP COLUMN IF EXISTS checked_in_at;

ALTER TABLE public.tournaments
    DROP CONSTRAINT IF EXISTS tournaments_check_in_setting_fkey,
    DROP CONSTRAINT IF EXISTS tournaments_check_in_window_length_check,
    DROP CONSTRAINT IF EXISTS tournaments_check_in_window_order_check,
    DROP CONSTRAINT IF EXISTS tournaments_check_in_closes_before_check,
    DROP CONSTRAINT IF EXISTS tournaments_check_in_opens_before_check,
    DROP CONSTRAINT IF EXISTS tournaments_elo_range_check,
    DROP CONSTRAINT IF EXISTS tournaments_min_role_fkey,
    DROP CONSTRAINT IF EXISTS tournaments_registration_type_fkey;

ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS check_in_ends_at,
    DROP COLUMN IF EXISTS check_in_closes_before_minutes,
    DROP COLUMN IF EXISTS check_in_opens_before_minutes,
    DROP COLUMN IF EXISTS check_in_setting,
    DROP COLUMN IF EXISTS check_in_required,
    DROP COLUMN IF EXISTS regions,
    DROP COLUMN IF EXISTS registration_passcode,
    DROP COLUMN IF EXISTS invite_only,
    DROP COLUMN IF EXISTS max_elo,
    DROP COLUMN IF EXISTS min_elo,
    DROP COLUMN IF EXISTS min_role,
    DROP COLUMN IF EXISTS registration_type;

DROP TABLE IF EXISTS public.e_tournament_free_agent_statuses;

DROP TABLE IF EXISTS public.e_tournament_registration_types;
