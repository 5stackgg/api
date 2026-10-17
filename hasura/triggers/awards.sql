-- Deleting a system_key award makes calculate_tournament_awards insert a NULL
-- award_id, so finishing a tournament fails outright.
CREATE OR REPLACE FUNCTION public.tbd_awards() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.system_key IS NOT NULL THEN
        RAISE EXCEPTION 'Built-in award "%" cannot be deleted', OLD.system_key;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_awards ON public.awards;
CREATE TRIGGER tbd_awards
    BEFORE DELETE ON public.awards
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_awards();

DROP TRIGGER IF EXISTS y_tbu_awards_last_changed_by ON public.awards;
CREATE TRIGGER y_tbu_awards_last_changed_by
    BEFORE UPDATE OF last_changed_by_steam_id ON public.awards
    FOR EACH ROW EXECUTE FUNCTION public.tbu_last_changed_by_named();

DROP TRIGGER IF EXISTS z_tbiu_awards_last_changed ON public.awards;
CREATE TRIGGER z_tbiu_awards_last_changed
    BEFORE INSERT OR UPDATE ON public.awards
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_stamp_last_changed(
        'name', 'description', 'tier', 'silhouette', 'image_url',
        'allow_multiple', 'tournament_id', 'event_id', 'season_id',
        'league_season_id'
    );
