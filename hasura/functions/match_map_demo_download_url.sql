CREATE OR REPLACE FUNCTION public.demo_download_url(match_map public.match_maps)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    download_url text;
BEGIN
    download_url := CONCAT('matches/', match_map.match_id, '/demos/map/', match_map.id);
    RETURN download_url;
END;
$$;
