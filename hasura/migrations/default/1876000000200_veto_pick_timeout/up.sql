ALTER TABLE public.match_options
    ADD COLUMN IF NOT EXISTS veto_pick_timeout integer NOT NULL DEFAULT 60;

-- 0 is the disable value, so this is >= 0 rather than the > 0 used by
-- auto_cancel_duration / live_match_timeout.
ALTER TABLE public.match_options
    DROP CONSTRAINT IF EXISTS match_options_veto_pick_timeout_check;

ALTER TABLE public.match_options
    ADD CONSTRAINT match_options_veto_pick_timeout_check CHECK (veto_pick_timeout >= 0);

ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS veto_pick_expires_at timestamptz;

ALTER TABLE public.match_map_veto_picks
    ADD COLUMN IF NOT EXISTS auto_picked boolean NOT NULL DEFAULT false;

ALTER TABLE public.match_region_veto_picks
    ADD COLUMN IF NOT EXISTS auto_picked boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS matches_veto_pick_expires_at_idx
    ON public.matches (veto_pick_expires_at)
    WHERE veto_pick_expires_at IS NOT NULL;
