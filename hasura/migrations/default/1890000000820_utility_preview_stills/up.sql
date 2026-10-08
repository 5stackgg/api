-- kind -> S3 key for each still a render filmed (stance, aim, aim_close,
-- landing). Written with the clip, so a lineup never shows stills from one
-- render beside the clip of another.
ALTER TABLE public.utility_lineups
    ADD COLUMN IF NOT EXISTS preview_stills jsonb;
