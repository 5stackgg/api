ALTER TABLE public.matches
    DROP COLUMN IF EXISTS elo_voided_by_steam_id,
    DROP COLUMN IF EXISTS elo_voided_at,
    DROP COLUMN IF EXISTS elo_voided;
