CREATE OR REPLACE FUNCTION public.tbiu_nade_drift_scans() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();

    IF NOT EXISTS (
        SELECT 1 FROM public.maps m WHERE m.name = NEW.map_name
    ) THEN
        RAISE EXCEPTION 'Unknown map: %', NEW.map_name USING ERRCODE = '22000';
    END IF;

    -- Timestamps are stamped from the status rather than by the caller: a scan
    -- is driven by a job that can die between the two writes, and a Finished
    -- row with no finished_at reads as still running forever.
    IF NEW.status = 'Running' AND NEW.started_at IS NULL THEN
        NEW.started_at = now();
    END IF;

    IF NEW.status IN ('Finished', 'Failed') AND NEW.finished_at IS NULL THEN
        NEW.finished_at = now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_nade_drift_scans ON public.nade_drift_scans;
CREATE TRIGGER tbiu_nade_drift_scans
    BEFORE INSERT OR UPDATE ON public.nade_drift_scans
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_nade_drift_scans();
