ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS logo text,
    ADD COLUMN IF NOT EXISTS homepage text,
    ADD COLUMN IF NOT EXISTS location text,
    ADD COLUMN IF NOT EXISTS latitude double precision,
    ADD COLUMN IF NOT EXISTS longitude double precision;

CREATE TABLE IF NOT EXISTS public.e_tournament_categories (
    value TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO public.e_tournament_categories (value, description) VALUES
    ('LAN', 'LAN'),
    ('LocationEvent', 'Location Event'),
    ('OnlineEvent', 'Online Event'),
    ('League', 'League')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS public.tournament_categories (
    tournament_id uuid NOT NULL
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE,
    category text NOT NULL
        REFERENCES public.e_tournament_categories(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    PRIMARY KEY (tournament_id, category)
);

CREATE INDEX IF NOT EXISTS tournament_categories_tournament_id_idx
    ON public.tournament_categories (tournament_id);

CREATE TABLE IF NOT EXISTS public.tournament_prizes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE,
    place text NOT NULL,
    prize text NOT NULL,
    "order" integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournament_prizes_tournament_id_idx
    ON public.tournament_prizes (tournament_id);

ALTER TABLE public.teams
    ADD COLUMN IF NOT EXISTS is_organization boolean NOT NULL DEFAULT false;

-- Links an "organisation" team to a tournament. When a team is added here every
-- member of that team's roster is expanded into tournament_organizers (handled in
-- the API via the tournament_organizer_team_events + team_roster event triggers).
CREATE TABLE IF NOT EXISTS public.tournament_organizer_teams (
    tournament_id uuid NOT NULL
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE,
    team_id uuid NOT NULL
        REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tournament_id, team_id)
);

CREATE INDEX IF NOT EXISTS tournament_organizer_teams_team_id_idx
    ON public.tournament_organizer_teams (team_id);

-- Tracks which organisation team an organizer row was expanded from. NULL means the
-- organizer was added manually; a non-NULL value is managed by the org-team sync and
-- is removed when the team is unlinked or drops off the team roster.
ALTER TABLE public.tournament_organizers
    ADD COLUMN IF NOT EXISTS organization_team_id uuid
        REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.match_options
    ADD COLUMN IF NOT EXISTS round_restart_delay integer,
    ADD COLUMN IF NOT EXISTS halftime_pausematch boolean NOT NULL DEFAULT false;

-- Winner-bracket advantage for the grand final of a double-elimination stage, expressed
-- in map points. The winner-bracket team (bracket.tournament_team_id_1 / lineup_1) starts
-- the grand-final match with this many map wins already banked. 0 disables the advantage.
-- update_match_state clamps it below ceil(best_of / 2) at apply time, since the GF's
-- best_of is only known per match; at or above the threshold the winner-bracket team
-- would otherwise take the match on the first map to finish, even one it lost.
ALTER TABLE public.tournament_stages
    ADD COLUMN IF NOT EXISTS final_map_advantage integer NOT NULL DEFAULT 0;

-- Added separately (not inline on ADD COLUMN) so it also lands on databases where the
-- column already existed from a pre-squash migration -- there ADD COLUMN IF NOT EXISTS
-- is a no-op and would skip an inline constraint.
ALTER TABLE public.tournament_stages
    DROP CONSTRAINT IF EXISTS tournament_stages_final_map_advantage_check;
ALTER TABLE public.tournament_stages
    ADD CONSTRAINT tournament_stages_final_map_advantage_check
        CHECK (final_map_advantage >= 0);
