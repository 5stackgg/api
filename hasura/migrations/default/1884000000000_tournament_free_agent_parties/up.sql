-- The 5stack matchmaking lobby the signup came from. No FK: tad_lobby_players
-- deletes the lobby row once its last member leaves, which would blank out a
-- party that is still queued for a tournament days later. Same call
-- match_lineup_players.party_id already makes.
ALTER TABLE public.tournament_free_agents
    ADD COLUMN IF NOT EXISTS party_id uuid;

CREATE INDEX IF NOT EXISTS idx_tournament_free_agents_party
    ON public.tournament_free_agents (tournament_id, party_id)
    WHERE party_id IS NOT NULL;
