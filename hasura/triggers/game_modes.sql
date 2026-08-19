CREATE OR REPLACE FUNCTION public.match_ranking_for_options(_match_options_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    -- Only a plain competitive match counts. Any custom mode plays under
    -- third-party plugins, so it never moves ELO -- unconditionally, whatever
    -- the mode's flags say. competitive_safe gates draft-lobby selection only.
    SELECT NOT EXISTS (
        SELECT 1
          FROM match_options mo
         WHERE mo.id = _match_options_id
           AND mo.game_mode_id IS NOT NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.tbi_matches_ranking() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.counts_toward_ranking = match_ranking_for_options(NEW.match_options_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_matches_ranking ON public.matches;
CREATE TRIGGER tbi_matches_ranking BEFORE INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbi_matches_ranking();

CREATE OR REPLACE FUNCTION public.tau_match_options_ranking() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- The mode can still be changed while a match is being set up; once it is
    -- Live tbu_match_options refuses the change, so this can never move under a
    -- match that is already being played.
    IF NEW.game_mode_id IS DISTINCT FROM OLD.game_mode_id THEN
        UPDATE matches
           SET counts_toward_ranking = match_ranking_for_options(NEW.id)
         WHERE match_options_id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_options_ranking ON public.match_options;
CREATE TRIGGER tau_match_options_ranking AFTER UPDATE ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tau_match_options_ranking();

CREATE OR REPLACE FUNCTION public.assert_game_mode_selectable(_game_mode_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _mode public.game_modes;
    _incompatible text[];
BEGIN
    IF _game_mode_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO _mode FROM game_modes WHERE id = _game_mode_id;

    IF _mode IS NULL THEN
        RAISE EXCEPTION 'Game mode does not exist' USING ERRCODE = '22000';
    END IF;

    IF _mode.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'Game mode "%" is archived', _mode.name USING ERRCODE = '22000';
    END IF;

    IF _mode.enabled = false THEN
        RAISE EXCEPTION 'Game mode "%" is disabled', _mode.name USING ERRCODE = '22000';
    END IF;

    -- Runtime compatibility comes from the plugins, not from the mode: a mode is
    -- runnable only where every plugin in it publishes a build. Selecting one
    -- the deployment cannot load would boot a server with none of them present
    -- and nothing to say why.
    SELECT array_agg(slug) INTO _incompatible
      FROM (
        SELECT mp.plugin_slug AS slug
          FROM game_mode_plugins mp
         WHERE mp.game_mode_id = _mode.id
           AND NOT EXISTS (
               SELECT 1 FROM game_plugin_versions v
                WHERE v.plugin_slug = mp.plugin_slug
                  AND v.runtime = active_plugin_runtime()
           )
         ORDER BY mp.plugin_slug
      ) conflicts;

    IF _incompatible IS NOT NULL AND array_length(_incompatible, 1) > 0 THEN
        RAISE EXCEPTION 'Game mode "%" needs % which has no % build',
            _mode.name,
            array_to_string(_incompatible, ', '),
            active_plugin_runtime()
            USING ERRCODE = '22000';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbiu_game_modes() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_game_modes ON public.game_modes;
CREATE TRIGGER tbiu_game_modes BEFORE INSERT OR UPDATE ON public.game_modes FOR EACH ROW EXECUTE FUNCTION public.tbiu_game_modes();

CREATE OR REPLACE FUNCTION public.tbd_game_modes() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _referencing int;
BEGIN
    SELECT count(*) INTO _referencing FROM match_options WHERE game_mode_id = OLD.id;

    -- The foreign key is RESTRICT rather than SET NULL on purpose. Detaching
    -- would rewrite the options row of a match that has already been played,
    -- which tbu_match_options refuses outright, and would erase which mode that
    -- match ran. Archiving hides the mode everywhere without touching history.
    IF _referencing > 0 THEN
        RAISE EXCEPTION 'Game mode "%" has been used by % match(es); archive it instead of deleting it', OLD.name, _referencing
            USING ERRCODE = '22000';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_game_modes ON public.game_modes;
CREATE TRIGGER tbd_game_modes BEFORE DELETE ON public.game_modes FOR EACH ROW EXECUTE FUNCTION public.tbd_game_modes();
