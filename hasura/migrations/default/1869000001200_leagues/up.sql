-- CAL/ESEA-style leagues: a single site-wide league with tiered divisions,
-- seasonal play, team-negotiated weekly scheduling, roster locks, playoffs and
-- promotion/relegation. Division play is materialized as regular tournaments
-- (RoundRobin/Swiss + elimination stages) per (season, division); these tables
-- own structure, registration, scheduling negotiation and cross-season identity.
--
-- Squash of the 1868000000100..1869000001100 league migrations, bumped +100 so
-- it re-runs cleanly on databases that already applied them. Fully idempotent.
-- Functions, views and triggers live in hasura/{functions,views,triggers} and
-- reapply on setup; migrations hold only schema DDL + guarded drops.

-- ===== Converge databases that ran the pre-squash migrations =====
-- The schema originally had a `leagues` entity owning per-league divisions,
-- seasons and teams, plus roster settings/functions under a league_* prefix
-- that now govern all team rosters under team_*.

-- The is_league_admin computed field takes the (now-removed) leagues composite
-- type as an argument; only drop it while that type still exists.
DO $leagues$
BEGIN
    IF to_regtype('public.leagues') IS NOT NULL THEN
        EXECUTE 'DROP FUNCTION IF EXISTS public.is_league_admin(public.leagues, json)';
    END IF;
END
$leagues$;

DROP FUNCTION IF EXISTS public.is_league_admin_for_session(uuid, json);
DROP FUNCTION IF EXISTS public.league_id_for_bracket(uuid);
DROP FUNCTION IF EXISTS public.league_min_roster_size();
DROP FUNCTION IF EXISTS public.league_max_roster_size();
DROP FUNCTION IF EXISTS public.league_max_subs();

-- Superseded roster triggers: the min-roster-floor BEFORE DELETE guard and the
-- insert-only mirror are replaced by soft-delete-aware versions in
-- hasura/triggers/league_team_rosters.sql.
DROP FUNCTION IF EXISTS public.tbd_league_team_rosters() CASCADE;
DROP FUNCTION IF EXISTS public.tai_league_team_rosters() CASCADE;

-- CASCADE also drops the composite unique constraints these columns carried.
ALTER TABLE IF EXISTS public.league_divisions DROP COLUMN IF EXISTS league_id CASCADE;
ALTER TABLE IF EXISTS public.league_seasons DROP COLUMN IF EXISTS league_id CASCADE;
ALTER TABLE IF EXISTS public.league_teams DROP COLUMN IF EXISTS league_id CASCADE;
ALTER TABLE IF EXISTS public.league_teams DROP COLUMN IF EXISTS name;

DROP TABLE IF EXISTS public.league_admins;
DROP TABLE IF EXISTS public.leagues;
DROP TABLE IF EXISTS public.e_league_statuses;

UPDATE public.settings
SET name = replace(name, 'public.league_', 'public.team_')
WHERE name IN (
    'public.league_min_roster_size',
    'public.league_max_roster_size',
    'public.league_max_subs'
);

-- ===== Enums =====
-- Seeded here as well as in hasura/enums so the FKs below always apply cleanly
-- on a fresh database (enums load after migrations).

CREATE TABLE IF NOT EXISTS public.e_league_season_statuses (
    value TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.e_league_registration_statuses (
    value TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.e_league_proposal_statuses (
    value TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.e_league_movement_types (
    value TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO public.e_league_season_statuses (value, description) VALUES
    ('Setup', 'Setup'),
    ('RegistrationOpen', 'Registration Open'),
    ('RegistrationClosed', 'Registration Closed'),
    ('Live', 'Live'),
    ('Playoffs', 'Playoffs'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO public.e_league_registration_statuses (value, description) VALUES
    ('Pending', 'Pending review'),
    ('Approved', 'Approved'),
    ('Waitlisted', 'Waitlisted'),
    ('Declined', 'Declined'),
    ('Withdrawn', 'Withdrawn')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO public.e_league_proposal_statuses (value, description) VALUES
    ('Pending', 'Pending response'),
    ('Accepted', 'Accepted'),
    ('Declined', 'Declined'),
    ('Countered', 'Countered with a new time'),
    ('Superseded', 'Superseded by another proposal'),
    ('Expired', 'Expired')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO public.e_league_movement_types (value, description) VALUES
    ('Promote', 'Promoted to a higher division'),
    ('Relegate', 'Relegated to a lower division'),
    ('Stay', 'Stays in the same division'),
    ('Remove', 'Removed from the league'),
    ('DirectPromote', 'Promoted directly to a higher division'),
    ('RelegationUp', 'Plays a relegation playoff for a higher-division spot'),
    ('Hold', 'Holds its division'),
    ('RelegationDown', 'Plays a relegation playoff to keep its division'),
    ('DirectRelegate', 'Relegated directly to a lower division')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

-- ===== Structure =====

CREATE TABLE IF NOT EXISTS public.league_divisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    -- 1 = top tier (Invite/Premier); higher numbers are lower skill tiers.
    tier SMALLINT NOT NULL CHECK (tier > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Divisions are never disabled: every tier is a promotion/relegation target and
-- simply may have no teams in a given season.
ALTER TABLE public.league_divisions DROP COLUMN IF EXISTS active;

-- Drop-then-add keeps these idempotent; the tier constraint is deferrable so
-- reorder/renumber can permute tiers in a single statement.
ALTER TABLE public.league_divisions DROP CONSTRAINT IF EXISTS league_divisions_tier_key;
ALTER TABLE public.league_divisions
    ADD CONSTRAINT league_divisions_tier_key UNIQUE (tier) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.league_divisions DROP CONSTRAINT IF EXISTS league_divisions_name_key;
ALTER TABLE public.league_divisions
    ADD CONSTRAINT league_divisions_name_key UNIQUE (name);

-- Seed the default division ladder only on a fresh ladder.
INSERT INTO public.league_divisions (name, tier)
SELECT v.name, v.tier
FROM (VALUES ('Invite', 1), ('Main', 2), ('Intermediate', 3), ('Open', 4))
     AS v(name, tier)
WHERE NOT EXISTS (SELECT 1 FROM public.league_divisions);

CREATE TABLE IF NOT EXISTS public.league_seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Setup'
        REFERENCES public.e_league_season_statuses(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    signup_opens_at TIMESTAMPTZ,
    signup_closes_at TIMESTAMPTZ,
    starts_at TIMESTAMPTZ,
    roster_lock_at TIMESTAMPTZ,
    match_weeks_count INT NOT NULL DEFAULT 8 CHECK (match_weeks_count > 0),
    playoff_seats INT NOT NULL DEFAULT 4 CHECK (playoff_seats >= 0),
    -- Superseded by the band counts below; kept for back-compat.
    promote_count INT NOT NULL DEFAULT 2 CHECK (promote_count >= 0),
    relegate_count INT NOT NULL DEFAULT 2 CHECK (relegate_count >= 0),
    match_options_id UUID
        REFERENCES public.match_options(id) ON UPDATE CASCADE ON DELETE SET NULL,
    default_best_of INT NOT NULL DEFAULT 1,
    playoff_best_of INT NOT NULL DEFAULT 3,
    min_roster_size INT NOT NULL DEFAULT 5,
    max_roster_size INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Best-of maps keyed by week number ({"5": 3} = week 5 is a BO3) and by
    -- native playoff stage round ("WB:1", "LB:2", "GF"). start_league_season /
    -- tau_league_seasons transform them into tournament_stages.settings ->
    -- 'round_best_of', which get_bracket_best_of resolves at materialization.
    week_best_of JSONB NOT NULL DEFAULT '{}'::jsonb,
    playoff_round_best_of JSONB NOT NULL DEFAULT '{}'::jsonb,
    playoff_stage_type TEXT NOT NULL DEFAULT 'SingleElimination'
        REFERENCES public.e_tournament_stage_types(value) ON UPDATE CASCADE ON DELETE RESTRICT
        CHECK (playoff_stage_type IN ('SingleElimination', 'DoubleElimination')),
    playoff_third_place_match BOOLEAN NOT NULL DEFAULT false,
    created_by_steam_id BIGINT
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    season_number INT,
    -- Used only when auto_regular_season_format is off.
    regular_season_stage_type TEXT NOT NULL DEFAULT 'RoundRobin'
        REFERENCES public.e_tournament_stage_types(value) ON UPDATE CASCADE ON DELETE RESTRICT
        CHECK (regular_season_stage_type IN ('RoundRobin', 'Swiss')),
    -- ESEA runs ~2 BO1 per week; regular-season rounds = weeks * games_per_week.
    games_per_week INT NOT NULL DEFAULT 1 CHECK (games_per_week > 0),
    -- ESEA-style promotion/relegation bands, by final rank within a division.
    direct_promote_count INT NOT NULL DEFAULT 1 CHECK (direct_promote_count >= 0),
    relegation_up_count INT NOT NULL DEFAULT 0 CHECK (relegation_up_count >= 0),
    relegation_down_count INT NOT NULL DEFAULT 0 CHECK (relegation_down_count >= 0),
    direct_relegate_count INT NOT NULL DEFAULT 1 CHECK (direct_relegate_count >= 0),
    -- When on, each division's regular-season format is chosen from its team
    -- count: a full round robin if it fits the season's rounds, else Swiss.
    auto_regular_season_format BOOLEAN NOT NULL DEFAULT true,
    CHECK (signup_opens_at IS NULL OR signup_closes_at IS NULL OR signup_opens_at < signup_closes_at)
);

ALTER TABLE public.league_seasons DROP CONSTRAINT IF EXISTS league_seasons_name_key;
ALTER TABLE public.league_seasons
    ADD CONSTRAINT league_seasons_name_key UNIQUE (name);
CREATE UNIQUE INDEX IF NOT EXISTS league_seasons_season_number_key
    ON public.league_seasons (season_number);

CREATE TABLE IF NOT EXISTS public.league_match_weeks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_season_id UUID NOT NULL
        REFERENCES public.league_seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    week_number INT NOT NULL CHECK (week_number > 0),
    opens_at TIMESTAMPTZ NOT NULL,
    closes_at TIMESTAMPTZ NOT NULL,
    -- Fallback tip-off applied to matchups the two teams never agreed on.
    default_match_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_season_id, week_number),
    CHECK (opens_at < closes_at),
    CHECK (default_match_at >= opens_at AND default_match_at <= closes_at)
);

-- Cross-season identity of a team inside the league; movements and history hang off this.
CREATE TABLE IF NOT EXISTS public.league_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL
        REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.league_teams DROP CONSTRAINT IF EXISTS league_teams_team_id_key;
ALTER TABLE public.league_teams
    ADD CONSTRAINT league_teams_team_id_key UNIQUE (team_id);

CREATE TABLE IF NOT EXISTS public.league_team_seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_season_id UUID NOT NULL
        REFERENCES public.league_seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    league_team_id UUID NOT NULL
        REFERENCES public.league_teams(id) ON UPDATE CASCADE ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'Pending'
        REFERENCES public.e_league_registration_statuses(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    requested_division_id UUID
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE SET NULL,
    assigned_division_id UUID
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE SET NULL,
    seed INT,
    captain_steam_id BIGINT
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    tournament_team_id UUID
        REFERENCES public.tournament_teams(id) ON UPDATE CASCADE ON DELETE SET NULL,
    registered_by_steam_id BIGINT
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decline_reason TEXT,
    UNIQUE (league_season_id, league_team_id)
);

-- Starter/Substitute/Benched mirrors the regular team_roster concept, so captains
-- can set a season lineup and subs. Removals are soft so history/reasons survive.
CREATE TABLE IF NOT EXISTS public.league_team_rosters (
    league_team_season_id UUID NOT NULL
        REFERENCES public.league_team_seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id BIGINT NOT NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at TIMESTAMPTZ,
    removed_reason TEXT,
    status TEXT NOT NULL DEFAULT 'Starter'
        REFERENCES public.e_team_roster_statuses(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    PRIMARY KEY (league_team_season_id, player_steam_id)
);

-- The (season x division) instance; owns the materialized tournament.
CREATE TABLE IF NOT EXISTS public.league_season_divisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_season_id UUID NOT NULL
        REFERENCES public.league_seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    league_division_id UUID NOT NULL
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    tournament_id UUID UNIQUE
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_season_id, league_division_id)
);

CREATE TABLE IF NOT EXISTS public.league_scheduling_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_bracket_id UUID NOT NULL
        REFERENCES public.tournament_brackets(id) ON UPDATE CASCADE ON DELETE CASCADE,
    proposed_by_steam_id BIGINT NOT NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    proposed_by_league_team_season_id UUID
        REFERENCES public.league_team_seasons(id) ON UPDATE CASCADE ON DELETE SET NULL,
    proposed_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending'
        REFERENCES public.e_league_proposal_statuses(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    responded_by_steam_id BIGINT
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Promotion/relegation ledger, computed at season finish and reviewed by admins.
CREATE TABLE IF NOT EXISTS public.league_team_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_season_id UUID NOT NULL
        REFERENCES public.league_seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    league_team_id UUID NOT NULL
        REFERENCES public.league_teams(id) ON UPDATE CASCADE ON DELETE CASCADE,
    from_division_id UUID
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE SET NULL,
    computed_to_division_id UUID
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE SET NULL,
    -- NULL means the computed destination stands; admins set this to override.
    final_to_division_id UUID
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE SET NULL,
    type TEXT NOT NULL
        REFERENCES public.e_league_movement_types(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    final_rank INT,
    approved_at TIMESTAMPTZ,
    approved_by_steam_id BIGINT
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_season_id, league_team_id)
);

-- Cross-division relegation playoffs: at each adjacent-division boundary the
-- higher division's RelegationDown teams play the lower division's RelegationUp
-- teams for the higher-division spots. Materialized as a normal tournament;
-- the result writes each team's final_to_division_id back onto its movement.
CREATE TABLE IF NOT EXISTS public.league_relegation_playoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_season_id UUID NOT NULL
        REFERENCES public.league_seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    higher_division_id UUID NOT NULL
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    lower_division_id UUID NOT NULL
        REFERENCES public.league_divisions(id) ON UPDATE CASCADE ON DELETE CASCADE,
    tournament_id UUID
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE SET NULL,
    -- How many of the contested teams end up in the higher division.
    higher_slots INT NOT NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_season_id, higher_division_id, lower_division_id)
);

CREATE INDEX IF NOT EXISTS idx_league_team_seasons_season ON public.league_team_seasons (league_season_id, status);
CREATE INDEX IF NOT EXISTS idx_league_season_divisions_season ON public.league_season_divisions (league_season_id);
CREATE INDEX IF NOT EXISTS idx_league_scheduling_proposals_bracket
    ON public.league_scheduling_proposals (tournament_bracket_id, status);
CREATE INDEX IF NOT EXISTS idx_league_relegation_playoffs_tournament
    ON public.league_relegation_playoffs (tournament_id);

-- ===== Tournament support =====
-- Generic capabilities leagues are built on, available to any tournament.

-- Optional cap on the number of rounds a RoundRobin stage generates, so large
-- fields can run a partial round robin (each team plays max_rounds distinct
-- opponents). NULL = full round robin. A real column (not settings jsonb) so
-- the stage regeneration triggers pick up changes.
ALTER TABLE public.tournament_stages
    ADD COLUMN IF NOT EXISTS max_rounds INT;

-- ESEA-style "Swiss group": pair by record but never advance/eliminate. Every
-- team plays exactly max_rounds rounds and is ranked in one table. When false,
-- Swiss behaves Valve-style (3 wins advance / 3 losses out / 5 rounds).
ALTER TABLE public.tournament_stages
    ADD COLUMN IF NOT EXISTS swiss_no_elimination BOOLEAN NOT NULL DEFAULT false;

-- 'auto' = auto_start materializes matches immediately. 'negotiated' = brackets
-- stay dormant until a time is agreed (captain proposals or a window default).
ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS scheduling_mode TEXT NOT NULL DEFAULT 'auto';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_scheduling_mode_check'
    ) THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_scheduling_mode_check
            CHECK (scheduling_mode IN ('auto', 'negotiated'));
    END IF;
END
$$;

-- Per (stage, round) scheduling window: when a round opens/closes for scheduling
-- and its default tip-off time. Generalizes league_match_weeks (which is
-- season-level) to any tournament stage.
CREATE TABLE IF NOT EXISTS public.tournament_stage_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_stage_id UUID NOT NULL
        REFERENCES public.tournament_stages(id) ON UPDATE CASCADE ON DELETE CASCADE,
    round INT NOT NULL,
    opens_at TIMESTAMPTZ,
    closes_at TIMESTAMPTZ,
    default_match_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tournament_stage_id, round)
);

-- ===== Notifications + settings =====

INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('LeagueProposalReceived', 'A league opponent proposed a match time'),
    ('LeagueProposalAccepted', 'Your league match time proposal was accepted'),
    ('LeagueProposalDeclined', 'Your league match time proposal was declined'),
    ('LeagueMatchUnscheduled', 'A league matchup is unscheduled and will default soon'),
    ('LeagueRegistrationDecision', 'Your league registration was reviewed')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO public.settings (name, value)
VALUES ('public.leagues_enabled', 'false')
ON CONFLICT (name) DO NOTHING;
