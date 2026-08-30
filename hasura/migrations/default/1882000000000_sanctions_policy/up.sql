CREATE TABLE IF NOT EXISTS public.e_sanction_scopes (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_sanction_scopes ("value", "description") VALUES
    ('matchmaking', 'Bars the player from queueing and from draft lobbies'),
    ('tournaments', 'Bars the player from joining a tournament roster or free agent pool'),
    ('both', 'Bars the player from matchmaking and tournaments')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

-- The shipped policy lives on the enum row rather than in application code so a
-- settings row that is missing (fresh database, an operator deleting one) can
-- never resolve to "no sanction" -- the resolver falls back to the default the
-- source was designed with instead. Repeated in hasura/enums/sanction-sources.sql,
-- which is re-applied every boot; this copy exists so the columns and the FKs
-- are in place before the enum file runs.
CREATE TABLE IF NOT EXISTS public.e_sanction_sources (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL,
    default_enabled boolean NOT NULL DEFAULT true,
    default_threshold integer NOT NULL DEFAULT 1,
    default_window_days integer NOT NULL DEFAULT 0,
    default_durations text NOT NULL DEFAULT '0',
    default_scope text NOT NULL DEFAULT 'both',
    writes_platform_ban boolean NOT NULL DEFAULT false
);

-- Minutes, escalating: the Nth occurrence picks the Nth entry, clamped to the
-- last one. 0 means the sanction never lifts on its own.
COMMENT ON COLUMN public.e_sanction_sources.default_durations IS 'Comma separated ban durations in minutes, indexed by occurrence count';

-- True when the source writes a real player_sanctions ban rather than a scoped
-- cooldown. Such a ban is enforced by is_banned() across the whole platform, so
-- it is deliberately left out of the scoped cooldown when its scope is 'both'.
COMMENT ON COLUMN public.e_sanction_sources.writes_platform_ban IS 'Source issues a player_sanctions ban row instead of a scoped cooldown';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e_sanction_sources_default_scope_fkey') THEN
        ALTER TABLE public.e_sanction_sources
            ADD CONSTRAINT e_sanction_sources_default_scope_fkey
            FOREIGN KEY (default_scope)
            REFERENCES public.e_sanction_scopes (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e_sanction_sources_default_threshold_check') THEN
        ALTER TABLE public.e_sanction_sources
            ADD CONSTRAINT e_sanction_sources_default_threshold_check
            CHECK (default_threshold >= 1);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e_sanction_sources_default_window_days_check') THEN
        ALTER TABLE public.e_sanction_sources
            ADD CONSTRAINT e_sanction_sources_default_window_days_check
            CHECK (default_window_days >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e_sanction_sources_default_durations_check') THEN
        ALTER TABLE public.e_sanction_sources
            ADD CONSTRAINT e_sanction_sources_default_durations_check
            CHECK (default_durations ~ '^\d+(,\d+)*$');
    END IF;
END
$$;

-- match_abandon and vac_ban reproduce what the platform already did before any
-- of this was configurable: the 7-day windowed escalating leaver cooldown from
-- get_player_matchmaking_cooldown, and the permanent platform-wide VAC ban from
-- SteamBansService. Turning the policy on must change nothing until an operator
-- edits it.
--
-- tournament_no_show is new, and is deliberately the gentlest of the three:
-- missing a tournament you signed up for is a scheduling failure, not the same
-- as abandoning a live match and ruining it for nine other people. A first
-- offence is never punished -- real life happens -- so it takes three inside a
-- 30 day window, and it bars tournaments only, never matchmaking.
INSERT INTO public.e_sanction_sources
    ("value", "description", default_enabled, default_threshold, default_window_days, default_durations, default_scope, writes_platform_ban)
VALUES
    ('match_abandon', 'A player left or never connected to a match they were rostered for', true, 1, 7, '10,60,120,240,480,960,1920', 'matchmaking', false),
    ('vac_ban', 'Steam reports a VAC or game ban on the player''s account', true, 1, 0, '0', 'both', true),
    ('tournament_no_show', 'A team missed a required tournament check-in', true, 3, 30, '10080', 'tournaments', false)
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

-- One row per player per tournament they were held out of. The tournament, not
-- the team, is the unit: a captain re-forming the same roster under a new team
-- must not buy a fresh set of occurrences.
CREATE TABLE IF NOT EXISTS public.tournament_no_shows (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tournament_id uuid NOT NULL,
    tournament_team_id uuid,
    player_steam_id bigint NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_no_shows_tournament_id_fkey') THEN
        ALTER TABLE public.tournament_no_shows
            ADD CONSTRAINT tournament_no_shows_tournament_id_fkey
            FOREIGN KEY (tournament_id)
            REFERENCES public.tournaments (id)
            ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;

    -- Nullable and SET NULL rather than CASCADE: a team can be removed from the
    -- bracket after the fact, and the players still missed the check-in.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_no_shows_tournament_team_id_fkey') THEN
        ALTER TABLE public.tournament_no_shows
            ADD CONSTRAINT tournament_no_shows_tournament_team_id_fkey
            FOREIGN KEY (tournament_team_id)
            REFERENCES public.tournament_teams (id)
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_no_shows_player_steam_id_fkey') THEN
        ALTER TABLE public.tournament_no_shows
            ADD CONSTRAINT tournament_no_shows_player_steam_id_fkey
            FOREIGN KEY (player_steam_id)
            REFERENCES public.players (steam_id)
            ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;

    -- abandoned_matches has no such constraint and CancelExpiredMatches has to
    -- order its writes around that. Here the constraint is the guard: a second
    -- close pass, or an organizer re-running a review, cannot double a player's
    -- count and so cannot double their ban.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_no_shows_tournament_player_key') THEN
        ALTER TABLE public.tournament_no_shows
            ADD CONSTRAINT tournament_no_shows_tournament_player_key
            UNIQUE (tournament_id, player_steam_id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_tournament_no_shows_player
    ON public.tournament_no_shows (player_steam_id, occurred_at);

-- The leaver cooldown counts and orders these rows on every player row Hasura
-- renders; the table only ever had an unindexed FK to players.
CREATE INDEX IF NOT EXISTS idx_abandoned_matches_steam_id
    ON public.abandoned_matches (steam_id, abandoned_at);

-- Carries an operator's explicit "off" across the rename. Runs before
-- HasuraService.updateSettings() seeds the defaults, so the migrated value wins
-- the ON CONFLICT DO NOTHING there.
INSERT INTO public.settings (name, value)
SELECT 'public.sanction_vac_ban_enabled', s.value
  FROM public.settings s
 WHERE s.name = 'public.steam_ban_enforcement_enabled'
ON CONFLICT (name) DO NOTHING;

DELETE FROM public.settings WHERE name = 'public.steam_ban_enforcement_enabled';
