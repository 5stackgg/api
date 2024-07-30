CREATE FUNCTION public.get_match_server_type(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    is_on_demand BOOL;
BEGIN
    IF match.server_id = null THEN
        return '';
    END IF;
	select on_demand into is_on_demand from servers where id = match.server_id;
	IF is_on_demand = true THEN
	    return 'OnDemand';
	END IF;
	return 'Dedicated';
END
$$;