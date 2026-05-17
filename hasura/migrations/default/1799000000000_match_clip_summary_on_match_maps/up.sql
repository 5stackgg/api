-- Denormalised clip-summary columns on match_maps so the Highlights feed
-- can paginate at match-group granularity without GROUP BY scans on every
-- subscription update. Triggers on match_clips (see hasura/triggers/
-- match_clips.sql) keep these in sync.

-- Drop the earlier v_match_clip_groups view if it was created on this
-- instance — match_maps now owns the summary directly.
DROP VIEW IF EXISTS public.v_match_clip_groups;

ALTER TABLE public.match_maps
    ADD COLUMN IF NOT EXISTS clips_count int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS public_clips_count int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS latest_clip_at timestamptz,
    ADD COLUMN IF NOT EXISTS public_latest_clip_at timestamptz;

-- Highlights feed (guest/user): paginate match_maps with at least one
-- public clip, newest activity first.
CREATE INDEX IF NOT EXISTS match_maps_public_latest_clip_at_idx
    ON public.match_maps (public_latest_clip_at DESC NULLS LAST)
    WHERE public_clips_count > 0;

-- Admin "All visibilities" view.
CREATE INDEX IF NOT EXISTS match_maps_latest_clip_at_idx
    ON public.match_maps (latest_clip_at DESC NULLS LAST)
    WHERE clips_count > 0;

-- Backfill from existing clips. Idempotent: rerunning produces the same
-- row state. match_maps with zero clips keep their default 0/null values.
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
