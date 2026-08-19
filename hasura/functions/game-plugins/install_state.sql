-- How far a requested plugin has actually got. Nodes converge on their own
-- schedule, so "installed" is never a single boolean: it is a count of the
-- nodes that have it against the nodes that should.
CREATE OR REPLACE FUNCTION public.game_plugin_installed_node_count(
    plugin public.game_plugins
) RETURNS integer AS $$
    SELECT count(*)::integer
      FROM public.game_server_node_plugins n
     WHERE n.plugin_slug = plugin.slug
       AND n.source = 'managed'
       AND n.detected = true;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.game_plugin_target_node_count(
    plugin public.game_plugins
) RETURNS integer AS $$
    SELECT count(*)::integer
      FROM public.game_server_nodes
     WHERE enabled = true
       AND status IN ('Online', 'NotAcceptingNewMatches');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.game_plugin_install_state(
    plugin public.game_plugins
) RETURNS text AS $$
DECLARE
    _requested boolean;
    _installed integer;
    _target integer;
    _failed integer;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.game_plugin_installs
         WHERE plugin_slug = plugin.slug AND enabled = true
    ) INTO _requested;

    SELECT count(*) INTO _installed
      FROM public.game_server_node_plugins
     WHERE plugin_slug = plugin.slug AND source = 'managed' AND detected = true;

    SELECT count(*) INTO _failed
      FROM public.game_server_node_plugins
     WHERE plugin_slug = plugin.slug AND status = 'Failed';

    IF NOT _requested THEN
        -- Present without being asked for: dropped in by hand. Reported rather
        -- than hidden, because it loads on every server regardless of mode.
        IF _installed > 0 OR EXISTS (
            SELECT 1 FROM public.game_server_node_plugins
             WHERE plugin_slug = plugin.slug AND source = 'manual'
        ) THEN
            RETURN 'Manual';
        END IF;

        RETURN 'NotInstalled';
    END IF;

    SELECT count(*) INTO _target
      FROM public.game_server_nodes
     WHERE enabled = true AND status IN ('Online', 'NotAcceptingNewMatches');

    IF _failed > 0 THEN
        RETURN 'Failed';
    END IF;

    IF _target = 0 OR _installed = 0 THEN
        RETURN 'Pending';
    END IF;

    IF _installed >= _target THEN
        RETURN 'Installed';
    END IF;

    RETURN 'Partial';
END;
$$ LANGUAGE plpgsql STABLE;
