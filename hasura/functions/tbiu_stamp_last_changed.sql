-- Keeps last_changed_at / last_changed_by_steam_id on a table whose settings
-- admins edit. TG_ARGV names the watched columns: a write that changes none of
-- them (a ping, a status flip) leaves the stamp alone.
--
-- The steam id is the Hasura session's. The API's own connection has none, so
-- its admin actions write last_changed_by_steam_id in the same UPDATE. Whether
-- the statement wrote it cannot be read off NEW, which carries OLD's value when
-- it did not and the same admin may change a row twice running, so
-- tbu_last_changed_by_named flags it from a BEFORE UPDATE OF trigger. Name that
-- trigger y_* and this one z_*: they then fire last, back to back, and see the
-- row as the table's other BEFORE triggers left it.
CREATE OR REPLACE FUNCTION public.tbiu_stamp_last_changed() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _steam_id bigint := public.hasura_session_steam_id();
    _named boolean := COALESCE(current_setting('fivestack.last_changed_by_named', true) = 'true', false);
    _new jsonb;
    _old jsonb;
    _column text;
BEGIN
    IF _named THEN
        PERFORM set_config('fivestack.last_changed_by_named', 'false', true);
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.last_changed_at := now();
        NEW.last_changed_by_steam_id := COALESCE(NEW.last_changed_by_steam_id, _steam_id);
        RETURN NEW;
    END IF;

    _new := to_jsonb(NEW);
    _old := to_jsonb(OLD);

    FOREACH _column IN ARRAY TG_ARGV LOOP
        IF (_new -> _column) IS DISTINCT FROM (_old -> _column) THEN
            NEW.last_changed_at := now();
            NEW.last_changed_by_steam_id := COALESCE(
                _steam_id,
                CASE WHEN _named THEN NEW.last_changed_by_steam_id END
            );
            RETURN NEW;
        END IF;
    END LOOP;

    -- An API action that saves settings kept in child tables (a server's map
    -- list, plugins, access lists) names the admin without changing a watched
    -- column; that is still a change. A NULL here is the foreign key's own
    -- ON DELETE SET NULL, not an edit.
    IF _named AND NEW.last_changed_by_steam_id IS NOT NULL THEN
        NEW.last_changed_at := now();
        NEW.last_changed_by_steam_id := COALESCE(_steam_id, NEW.last_changed_by_steam_id);
        RETURN NEW;
    END IF;

    -- Nothing watched changed, so the stamp stands. The one exception is the
    -- foreign key's own ON DELETE SET NULL / ON UPDATE CASCADE: by then the
    -- player OLD names is gone, and putting it back would leave the row
    -- pointing at nobody.
    NEW.last_changed_at := OLD.last_changed_at;
    IF NEW.last_changed_by_steam_id IS DISTINCT FROM OLD.last_changed_by_steam_id
       AND (
           OLD.last_changed_by_steam_id IS NULL
           OR EXISTS (SELECT 1 FROM public.players WHERE steam_id = OLD.last_changed_by_steam_id)
       ) THEN
        NEW.last_changed_by_steam_id := OLD.last_changed_by_steam_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_last_changed_by_named() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM set_config('fivestack.last_changed_by_named', 'true', true);
    RETURN NEW;
END;
$$;
