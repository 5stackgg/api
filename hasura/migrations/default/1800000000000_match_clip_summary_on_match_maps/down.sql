DROP INDEX IF EXISTS public.match_maps_public_latest_clip_at_idx;
DROP INDEX IF EXISTS public.match_maps_latest_clip_at_idx;

ALTER TABLE public.match_maps
    DROP COLUMN IF EXISTS clips_count,
    DROP COLUMN IF EXISTS public_clips_count,
    DROP COLUMN IF EXISTS latest_clip_at,
    DROP COLUMN IF EXISTS public_latest_clip_at;
