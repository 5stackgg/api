CREATE OR REPLACE FUNCTION public.get_match_server_plugin_runtime(match public.matches)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    runtime text;
BEGIN
    IF match.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT plugin_runtime
	    INTO runtime
	    FROM servers
	    WHERE id = match.server_id;

    RETURN runtime;
END
$$;
