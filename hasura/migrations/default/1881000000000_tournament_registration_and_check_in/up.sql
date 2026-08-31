CREATE TABLE IF NOT EXISTS public.e_tournament_registration_types (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_tournament_registration_types ("value", "description") VALUES
    ('teams', 'Only pre-formed teams may register'),
    ('free_agents', 'Only individual players may register; teams are drafted from the pool'),
    ('both', 'Pre-formed teams and individual free agents may both register')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

CREATE TABLE IF NOT EXISTS public.e_tournament_free_agent_statuses (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_tournament_free_agent_statuses ("value", "description") VALUES
    ('registered', 'Signed up and waiting for the draft'),
    ('drafted', 'Placed on a drafted team'),
    ('waitlisted', 'Did not make the cut; first in line if a slot opens'),
    ('withdrawn', 'Left the free agent pool')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS registration_type text NOT NULL DEFAULT 'teams',
    ADD COLUMN IF NOT EXISTS min_role text,
    ADD COLUMN IF NOT EXISTS min_elo integer,
    ADD COLUMN IF NOT EXISTS max_elo integer,
    ADD COLUMN IF NOT EXISTS invite_only boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS registration_passcode text,
    ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS check_in_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS check_in_setting text NOT NULL DEFAULT 'Captains',
    ADD COLUMN IF NOT EXISTS check_in_opens_before_minutes integer NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS check_in_closes_before_minutes integer NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS check_in_ends_at timestamptz;

-- Reuses e_check_in_settings (Admin / Captains / Players), the same enum
-- match_options.check_in_setting already points at, rather than minting a
-- parallel vocabulary for the same three answers.
COMMENT ON COLUMN public.tournaments.check_in_setting IS 'Who confirms a team: Captains, every rostered Player, or the organizer (Admin)';

-- The regions matches are HOSTED in, not a gate on who may enter: 5stack has no
-- per-player region, so this is a preference the scheduler reads, mirroring
-- team_scrim_settings.regions.
COMMENT ON COLUMN public.tournaments.regions IS 'Preferred server regions for hosted matches';

-- Stamped once, when the window opens, and read as a one-way latch by
-- tournament_check_in_started. NULL means the window has never opened.
COMMENT ON COLUMN public.tournaments.check_in_ends_at IS 'When the check-in window closes; NULL until it opens';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_registration_type_fkey') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_registration_type_fkey
            FOREIGN KEY (registration_type)
            REFERENCES public.e_tournament_registration_types (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_min_role_fkey') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_min_role_fkey
            FOREIGN KEY (min_role)
            REFERENCES public.e_player_roles (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_setting_fkey') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_setting_fkey
            FOREIGN KEY (check_in_setting)
            REFERENCES public.e_check_in_settings (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_elo_range_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_elo_range_check
            CHECK (min_elo IS NULL OR max_elo IS NULL OR max_elo >= min_elo);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_opens_before_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_opens_before_check
            CHECK (check_in_opens_before_minutes BETWEEN 15 AND 240);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_closes_before_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_closes_before_check
            CHECK (check_in_closes_before_minutes BETWEEN 5 AND 60);
    END IF;

    -- Two constraints, not one: a >= 5 gap already implies opens > closes, but
    -- keeping both means the error message names the rule that was broken.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_window_order_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_window_order_check
            CHECK (check_in_opens_before_minutes > check_in_closes_before_minutes);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_window_length_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_window_length_check
            CHECK (check_in_opens_before_minutes - check_in_closes_before_minutes >= 5);
    END IF;
END
$$;

-- The ONE signal everything downstream reads. In Players mode a trigger on
-- tournament_team_roster rolls the individual confirmations up into it, so
-- seeding, standings and the UI never have to know which mode is in force.
ALTER TABLE public.tournament_teams
    ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

ALTER TABLE public.tournament_team_roster
    ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

CREATE TABLE IF NOT EXISTS public.tournament_free_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'registered' REFERENCES public.e_tournament_free_agent_statuses (value) ON UPDATE CASCADE,
    tournament_team_id uuid REFERENCES public.tournament_teams (id) ON UPDATE CASCADE ON DELETE SET NULL,
    checked_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tournament_free_agents_tournament_id_player_steam_id_key UNIQUE (tournament_id, player_steam_id)
);

-- Load-bearing, not bookkeeping: draft_tournament_free_agent_teams decides WHO
-- gets one of the limited slots purely by this column. ELO only decides which
-- team a selected player lands on, so an early low-rated signup can never be
-- bumped out by a late high-rated one.
COMMENT ON COLUMN public.tournament_free_agents.created_at IS 'Registration priority: decides who makes the cut';

CREATE INDEX IF NOT EXISTS idx_tournament_free_agents_tournament_status
    ON public.tournament_free_agents (tournament_id, status);

-- Type-definition table for get_tournament_leaderboard; never written to.
-- DEDICATED rather than reusing leaderboard_entries: RETURN QUERY SELECT matches
-- by column POSITION, so extending the shared type would force lockstep edits to
-- get_leaderboard, get_event_leaderboard and get_league_season_leaderboard.
CREATE TABLE IF NOT EXISTS public.tournament_leaderboard_entries (
    player_steam_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    player_avatar_url TEXT,
    player_custom_avatar_url TEXT,
    player_country TEXT,
    tournament_team_id UUID,
    team_name TEXT,
    rating FLOAT NOT NULL DEFAULT 0,
    adr FLOAT NOT NULL DEFAULT 0,
    kills INT NOT NULL DEFAULT 0,
    deaths INT NOT NULL DEFAULT 0,
    assists INT NOT NULL DEFAULT 0,
    kdr FLOAT NOT NULL DEFAULT 0,
    headshot_percentage FLOAT NOT NULL DEFAULT 0,
    rounds_played INT NOT NULL DEFAULT 0,
    matches_played INT NOT NULL DEFAULT 0
);
