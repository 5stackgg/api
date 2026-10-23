-- A team's scrim regions become its scrims' match region, so a LAN region
-- there follows the same rule as on match_options. Only the regions a save
-- adds count: the web saves by upsert, whose BEFORE INSERT sees the whole list
-- before the conflict turns it into an update.
CREATE OR REPLACE FUNCTION public.tbiu_team_scrim_settings_lan_regions()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _existing text[];
BEGIN
    IF TG_OP = 'UPDATE' THEN
        _existing := OLD.regions;
    ELSE
        SELECT regions INTO _existing
        FROM team_scrim_settings
        WHERE team_id = NEW.team_id;
    END IF;

    PERFORM assert_lan_regions_reachable(ARRAY(
        SELECT unnest(NEW.regions)
        EXCEPT
        SELECT unnest(COALESCE(_existing, '{}'))
    ));

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_team_scrim_settings_lan_regions
    ON public.team_scrim_settings;
CREATE TRIGGER tbiu_team_scrim_settings_lan_regions
    BEFORE INSERT OR UPDATE OF regions ON public.team_scrim_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.tbiu_team_scrim_settings_lan_regions();
