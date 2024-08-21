CREATE OR REPLACE FUNCTION public.demo_download_url(match_map_demo public.match_map_demos)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    download_url text;
BEGIN
    download_url := CONCAT('matches/', match_map_demo.match_id, '/demos/map/', match_map_demo.match_map_id);
    RETURN download_url;
END;
$$;
