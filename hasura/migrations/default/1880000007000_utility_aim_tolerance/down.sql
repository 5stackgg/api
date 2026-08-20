ALTER TABLE public.utility_lineups
    DROP CONSTRAINT IF EXISTS utility_lineups_aim_tolerance_sane;

ALTER TABLE public.utility_lineups
    DROP COLUMN IF EXISTS aim_tolerance;
