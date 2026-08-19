-- How far a requested plugin has actually got. Nodes converge on their own
-- schedule, so "installed" is never a single boolean: it is a count of the
-- nodes that have it against the nodes that should.
--
-- Every count below joins game_server_nodes and filters the same way as
-- game_plugin_target_node_count. Counting rows for nodes the target excludes is
-- what let a plugin present only on disabled nodes report Installed, and let a
-- Failed row on a decommissioned node pin the plugin at Failed forever --
-- disabling a node does not delete what it reported.
CREATE OR REPLACE FUNCTION public.game_plugin_installed_node_count(
    plugin public.game_plugins
) RETURNS integer AS $$
    SELECT count(*)::integer
      FROM public.game_server_node_plugins n
      INNER JOIN public.game_server_nodes g ON g.id = n.game_server_node_id
     WHERE n.plugin_slug = plugin.slug
       AND n.source = 'managed'
       AND n.detected = true
       AND g.enabled = true
       AND g.status IN ('Online', 'NotAcceptingNewMatches');
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
    _manual boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.game_plugin_installs
         WHERE plugin_slug = plugin.slug AND enabled = true
    ) INTO _requested;

    SELECT count(*) FILTER (WHERE n.source = 'managed' AND n.detected = true),
           count(*) FILTER (WHERE n.status = 'Failed'),
           bool_or(n.source = 'manual')
      INTO _installed, _failed, _manual
      FROM public.game_server_node_plugins n
      INNER JOIN public.game_server_nodes g ON g.id = n.game_server_node_id
     WHERE n.plugin_slug = plugin.slug
       AND g.enabled = true
       AND g.status IN ('Online', 'NotAcceptingNewMatches');

    IF NOT _requested THEN
        -- Present without being asked for: dropped in by hand. Reported rather
        -- than hidden, because it loads on every server regardless of mode.
        IF _installed > 0 OR COALESCE(_manual, false) THEN
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
