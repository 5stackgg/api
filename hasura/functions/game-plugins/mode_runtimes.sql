-- These returned text[] before. CREATE OR REPLACE cannot change a function's
-- return type, so any database that already has the old signature needs it
-- dropped first -- this file is re-applied on every boot.
DROP FUNCTION IF EXISTS public.game_mode_supported_runtimes(public.game_modes);
DROP FUNCTION IF EXISTS public.game_mode_runtime_conflicts(public.game_modes);

-- Which frameworks a mode can actually run on: the intersection of what every
-- plugin in it publishes for. An empty result means the selection is impossible
-- -- two plugins that exist for different frameworks and can never load together.
-- jsonb, not text[]: Hasura only accepts a base type as a computed field's
-- return, and an array type is not one. It arrives in GraphQL as a JSON array
-- either way.
CREATE OR REPLACE FUNCTION public.game_mode_supported_runtimes(mode public.game_modes)
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    AS $$
    SELECT to_jsonb(CASE
        -- A mode with no plugins is just cvars and a map pool, so it runs anywhere.
        WHEN NOT EXISTS (
            SELECT 1 FROM public.game_mode_plugins WHERE game_mode_id = mode.id
        )
        THEN ARRAY(SELECT value FROM public.e_plugin_runtimes ORDER BY value)
        ELSE ARRAY(
            SELECT r.value
              FROM public.e_plugin_runtimes r
             WHERE NOT EXISTS (
                 SELECT 1
                   FROM public.game_mode_plugins mp
                  WHERE mp.game_mode_id = mode.id
                    AND NOT EXISTS (
                        SELECT 1
                          FROM public.game_plugin_versions v
                         WHERE v.plugin_slug = mp.plugin_slug
                           AND v.runtime = r.value
                    )
             )
             ORDER BY r.value
        )
    END);
$$;

-- Named so the panel can say which plugin is the odd one out rather than only
-- that the combination does not work.
CREATE OR REPLACE FUNCTION public.game_mode_runtime_conflicts(mode public.game_modes)
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    AS $$
    SELECT to_jsonb(COALESCE(array_agg(mp.plugin_slug ORDER BY mp.plugin_slug), ARRAY[]::text[]))
      FROM public.game_mode_plugins mp
     WHERE mp.game_mode_id = mode.id
       AND NOT EXISTS (
           SELECT 1
             FROM public.game_plugin_versions v
            WHERE v.plugin_slug = mp.plugin_slug
              AND v.runtime = public.active_plugin_runtime()
       );
$$;
