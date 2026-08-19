-- map_name is a plain text column rather than a FK for the same reason
-- nade_lineups keeps one: maps is UNIQUE (name, type). This is the check that
-- keeps it honest.
CREATE OR REPLACE FUNCTION public.tbiu_nade_playbooks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();

    IF NOT EXISTS (
        SELECT 1 FROM public.maps m WHERE m.name = NEW.map_name
    ) THEN
        RAISE EXCEPTION 'Unknown map: %', NEW.map_name USING ERRCODE = '22000';
    END IF;

    -- Deleting a team sets team_id to NULL here, and a BEFORE trigger runs
    -- before the CHECK -- so without this, a team with playbooks could not be
    -- deleted at all. Falling back to Private leaves the owner their book.
    IF TG_OP = 'UPDATE'
       AND OLD.team_id IS NOT NULL
       AND NEW.team_id IS NULL
       AND NEW.visibility = 'Team' THEN
        NEW.visibility = 'Private';
    END IF;

    -- The steps are validated against the playbook's map on the way in, so a
    -- map change under a written book would silently leave every step pointing
    -- at another map's geometry.
    IF TG_OP = 'UPDATE'
       AND NEW.map_name IS DISTINCT FROM OLD.map_name
       AND EXISTS (
           SELECT 1 FROM public.nade_playbook_steps s WHERE s.playbook_id = NEW.id
       ) THEN
        RAISE EXCEPTION 'Remove the steps before moving a playbook to another map'
            USING ERRCODE = '22000';
    END IF;

    -- A team playbook has to belong to a team the owner is actually on. The
    -- NULL case is left to nade_playbooks_team_scope_chk, which says so more
    -- precisely.
    IF NEW.visibility = 'Team'
       AND NEW.team_id IS NOT NULL
       AND NOT public.is_nade_team_member(NEW.team_id, NEW.owner_steam_id) THEN
        RAISE EXCEPTION 'You are not on that team' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_nade_playbooks ON public.nade_playbooks;
CREATE TRIGGER tbiu_nade_playbooks
    BEFORE INSERT OR UPDATE ON public.nade_playbooks
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_nade_playbooks();

CREATE OR REPLACE FUNCTION public.tbiu_nade_playbook_steps() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- An execute is one map's worth of utility. A step pointing at another
    -- map's lineup would have the plugin count down to a throw nobody in the
    -- server can make.
    IF NOT EXISTS (
        SELECT 1
          FROM public.nade_playbooks p
          INNER JOIN public.nade_lineups l ON l.id = NEW.nade_lineup_id
         WHERE p.id = NEW.playbook_id
           AND p.map_name = l.map_name
    ) THEN
        RAISE EXCEPTION 'That lineup is not on this playbook''s map'
            USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_nade_playbook_steps ON public.nade_playbook_steps;
CREATE TRIGGER tbiu_nade_playbook_steps
    BEFORE INSERT OR UPDATE ON public.nade_playbook_steps
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_nade_playbook_steps();
