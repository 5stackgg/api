CREATE OR REPLACE FUNCTION public.has_active_matches(match_options public.match_options)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM matches m
        WHERE m.match_options_id = match_options.id
          AND m.status IN ('Live', 'Finished', 'Forfeit', 'Tie', 'Surrendered')
    );
$$;
