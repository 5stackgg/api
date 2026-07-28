CREATE TABLE IF NOT EXISTS public.e_match_party_sources (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_match_party_sources (value, description) VALUES
    ('lobby', '5stack matchmaking lobby'),
    ('valve', 'Valve matchmaking reservation'),
    ('faceit', 'FACEIT match room party')
ON CONFLICT (value) DO NOTHING;

-- Solo queuers stay NULL. No FK to lobbies: tad_lobby_players deletes the
-- lobby row once the last member leaves, which would blank out the history of
-- every match it ever played.
ALTER TABLE public.match_lineup_players
    ADD COLUMN IF NOT EXISTS party_id uuid,
    ADD COLUMN IF NOT EXISTS party_source text
        REFERENCES public.e_match_party_sources(value)
        ON UPDATE cascade ON DELETE set null;

CREATE INDEX IF NOT EXISTS idx_match_lineup_players_party
    ON public.match_lineup_players (party_id)
    WHERE party_id IS NOT NULL;

-- The reservation is only available at share-code resolve time, long before
-- the match row exists.
ALTER TABLE public.pending_match_imports
    ADD COLUMN IF NOT EXISTS parties jsonb;
