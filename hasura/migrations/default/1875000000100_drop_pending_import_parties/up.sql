-- Valve does not expose queue parties after a match ends. Verified at the wire
-- level: the reservation returned by MatchListRequestFullGameInfo contains only
-- account_ids, and the CS2 demo carries no party data anywhere. Nothing ever
-- wrote a non-null value here.
ALTER TABLE public.pending_match_imports
    DROP COLUMN IF EXISTS parties;
