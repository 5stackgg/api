CREATE TABLE IF NOT EXISTS public.e_match_party_sources (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_match_party_sources (value, description) VALUES
    ('lobby', '5stack matchmaking lobby'),
    ('valve', 'Valve matchmaking reservation'),
    ('faceit', 'FACEIT match room party')
ON CONFLICT (value) DO NOTHING;

-- party_id groups the players who queued together within a single match.
-- It is not stable across matches (except for 5stack, where it is the
-- lobbies.id), so "who do I queue with" is a self-join aggregated over
-- matches rather than a lookup. Solo queuers stay NULL — one player is
-- not a party.
--
-- No FK to lobbies: tad_lobby_players deletes the lobby row as soon as the
-- last member leaves, which would blank out the history of every match
-- that lobby ever played.
ALTER TABLE public.match_lineup_players
    ADD COLUMN IF NOT EXISTS party_id uuid,
    ADD COLUMN IF NOT EXISTS party_source text
        REFERENCES public.e_match_party_sources(value)
        ON UPDATE cascade ON DELETE set null;

CREATE INDEX IF NOT EXISTS idx_match_lineup_players_party
    ON public.match_lineup_players (party_id)
    WHERE party_id IS NOT NULL;

-- Valve's GC reservation carries the party grouping, but it is only
-- available at share-code resolve time — long before the demo is parsed
-- and the match row exists. Park it on the pending row so the parse job
-- can stamp it onto the lineup players.
ALTER TABLE public.pending_match_imports
    ADD COLUMN IF NOT EXISTS parties jsonb;
