ALTER TABLE public.players
    DROP COLUMN IF EXISTS ban_ends_at,
    DROP COLUMN IF EXISTS gag_ends_at,
    DROP COLUMN IF EXISTS mute_ends_at;
