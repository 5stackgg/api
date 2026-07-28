-- The share code is what lets us re-ask the GC about a match (it decodes to
-- the matchId/outcomeId/token triple requestGame needs). It was being consumed
-- at import and dropped: pending_match_imports holds it, and that row is
-- deleted once the import succeeds.
--
-- Without it, regenerating party data for an existing match is impossible —
-- requestRecentGames only answers for accounts the GC bot is authorized for,
-- and the replay URL carries matchId and outcomeId but not the token.
ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS share_code text;
