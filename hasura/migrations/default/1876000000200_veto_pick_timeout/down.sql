DROP INDEX IF EXISTS public.matches_veto_pick_expires_at_idx;

ALTER TABLE public.match_region_veto_picks DROP COLUMN IF EXISTS auto_picked;

ALTER TABLE public.match_map_veto_picks DROP COLUMN IF EXISTS auto_picked;

ALTER TABLE public.matches DROP COLUMN IF EXISTS veto_pick_expires_at;

ALTER TABLE public.match_options
    DROP CONSTRAINT IF EXISTS match_options_veto_pick_timeout_check;

ALTER TABLE public.match_options DROP COLUMN IF EXISTS veto_pick_timeout;
