-- The only handle the GC accepts for re-asking about a match: it decodes to
-- the matchId/outcomeId/token triple. requestRecentGames answers only for
-- accounts the bot is authorized for, and the replay URL has no token.
ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS share_code text;
