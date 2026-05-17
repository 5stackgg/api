DROP VIEW IF EXISTS public.v_match_clip_groups;

ALTER TABLE public.match_maps
    ADD COLUMN IF NOT EXISTS clips_count int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS public_clips_count int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS latest_clip_at timestamptz,
    ADD COLUMN IF NOT EXISTS public_latest_clip_at timestamptz;

CREATE INDEX IF NOT EXISTS match_maps_public_latest_clip_at_idx
    ON public.match_maps (public_latest_clip_at DESC NULLS LAST)
    WHERE public_clips_count > 0;

CREATE INDEX IF NOT EXISTS match_maps_latest_clip_at_idx
    ON public.match_maps (latest_clip_at DESC NULLS LAST)
    WHERE clips_count > 0;

UPDATE public.match_maps mm
SET
    clips_count = s.total_count,
    public_clips_count = s.public_count,
    latest_clip_at = s.total_latest,
    public_latest_clip_at = s.public_latest
FROM (
    SELECT
        mc.match_map_id,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE mc.visibility = 'public')::int AS public_count,
        MAX(mc.created_at) AS total_latest,
        MAX(mc.created_at) FILTER (WHERE mc.visibility = 'public') AS public_latest
    FROM public.match_clips mc
    GROUP BY mc.match_map_id
) s
WHERE mm.id = s.match_map_id;
