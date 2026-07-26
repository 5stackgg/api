-- A season has no status column, so "ended" is ends_at moving into the past.
CREATE OR REPLACE FUNCTION public.tau_seasons_awards() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _was_over boolean := OLD.ends_at IS NOT NULL AND OLD.ends_at <= now();
    _is_over boolean := NEW.ends_at IS NOT NULL AND NEW.ends_at <= now();
BEGIN
    IF _is_over AND NOT _was_over THEN
        PERFORM public.calculate_season_awards(NEW.id);
    ELSIF _was_over AND NOT _is_over THEN
        DELETE FROM public.award_recipients
        WHERE season_id = NEW.id AND source = 'season';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_seasons_awards ON public.seasons;
CREATE TRIGGER tau_seasons_awards
    AFTER UPDATE ON public.seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_seasons_awards();
