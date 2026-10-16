DROP INDEX IF EXISTS public.idx_matches_status_lineup;
CREATE INDEX idx_matches_status_lineup
    ON public.matches (status, lineup_1_id, lineup_2_id)
    WHERE status IN ('Live', 'Veto');
