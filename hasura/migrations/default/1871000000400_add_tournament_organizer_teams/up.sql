-- Links an "organisation" team to a tournament. When a team is added here every
-- member of that team's roster is expanded into tournament_organizers (handled in
-- the API via the addTournamentOrganizerTeam action + team_roster event trigger).
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
    ADD COLUMN organization_team_id uuid
        REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE SET NULL;
