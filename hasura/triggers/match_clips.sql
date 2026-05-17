CREATE OR REPLACE FUNCTION public.recompute_match_clip_summary(p_match_map_id uuid)
    RETURNS void
    LANGUAGE sql
    AS $$
    UPDATE public.match_maps mm
    SET
        clips_count = COALESCE(s.total_count, 0),
        public_clips_count = COALESCE(s.public_count, 0),
        latest_clip_at = s.total_latest,
        public_latest_clip_at = s.public_latest
    FROM (
        SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE visibility = 'public')::int AS public_count,
            MAX(created_at) AS total_latest,
            MAX(created_at) FILTER (WHERE visibility = 'public') AS public_latest
        FROM public.match_clips
        WHERE match_map_id = p_match_map_id
    ) s
    WHERE mm.id = p_match_map_id;
$$;


CREATE OR REPLACE FUNCTION public.tai_match_clips_summary()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.match_maps
    SET
        clips_count = clips_count + 1,
        public_clips_count = public_clips_count
            + CASE WHEN NEW.visibility = 'public' THEN 1 ELSE 0 END,
        latest_clip_at = GREATEST(latest_clip_at, NEW.created_at),
        public_latest_clip_at = CASE
            WHEN NEW.visibility = 'public'
                THEN GREATEST(public_latest_clip_at, NEW.created_at)
            ELSE public_latest_clip_at
        END
    WHERE id = NEW.match_map_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_clips_summary ON public.match_clips;
CREATE TRIGGER tai_match_clips_summary
    AFTER INSERT ON public.match_clips
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_match_clips_summary();


CREATE OR REPLACE FUNCTION public.tau_match_clips_summary()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.match_map_id IS DISTINCT FROM OLD.match_map_id THEN
        PERFORM public.recompute_match_clip_summary(OLD.match_map_id);
        PERFORM public.recompute_match_clip_summary(NEW.match_map_id);
    ELSIF NEW.visibility IS DISTINCT FROM OLD.visibility
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        PERFORM public.recompute_match_clip_summary(NEW.match_map_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_clips_summary ON public.match_clips;
CREATE TRIGGER tau_match_clips_summary
    AFTER UPDATE ON public.match_clips
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_match_clips_summary();


CREATE OR REPLACE FUNCTION public.tad_match_clips_summary()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.recompute_match_clip_summary(OLD.match_map_id);
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_match_clips_summary ON public.match_clips;
CREATE TRIGGER tad_match_clips_summary
    AFTER DELETE ON public.match_clips
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_match_clips_summary();
