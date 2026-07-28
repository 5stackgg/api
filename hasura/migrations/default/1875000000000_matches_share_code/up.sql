-- Our one stable handle on a Valve match: demo URLs expire, share codes don't,
-- so this is what lets us ask the GC about a match again later. It otherwise
-- only lives on pending_match_imports, which ParseImportedDemo deletes on a
-- successful import.
ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS share_code text;

CREATE INDEX IF NOT EXISTS idx_matches_share_code
    ON public.matches (share_code)
    WHERE share_code IS NOT NULL;
