-- Marks a team the free-agent draft generated, as opposed to one that
-- registered. The draft's idempotency guard used to be "any tournament_teams
-- row exists", which meant registration_type = 'both' never drafted at all: the
-- first real team that signed up permanently blocked the pool.
ALTER TABLE public.tournament_teams
    ADD COLUMN IF NOT EXISTS is_drafted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tournament_teams.is_drafted IS 'Created by draft_tournament_free_agent_teams rather than registered';

-- A session-scoped unlock rather than a passcode carried on every write: the
-- join flow is a plain Hasura insert into tournament_teams /
-- tournament_free_agents, and there is nowhere on those rows to put a secret
-- the insert trigger could check. The player trades the passcode for a row
-- here once, and the triggers then only ask whether that row exists.
CREATE TABLE IF NOT EXISTS public.tournament_registration_unlocks (
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tournament_id, player_steam_id)
);
