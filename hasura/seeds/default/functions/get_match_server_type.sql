CREATE OR REPLACE FUNCTION public.get_match_server_type(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    on_demand BOOL;
BEGIN
    IF match.server_id = null THEN
        return '';
    END IF;
	select is_on_demand into on_demand from servers where id = match.server_id;
	IF on_demand = true THEN
	    return 'OnDemand';
	END IF;
	return 'Dedicated';
END
$$;