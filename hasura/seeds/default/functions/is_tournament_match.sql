CREATE OR REPLACE FUNCTION public.is_tournament_match(
    match public.matches
) RETURNS boolean
    LANGUAGE plpgsql STABLE
AS $$
DECLARE
    result boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.matches m
        INNER JOIN public.tournament_brackets tb ON tb.match_id = m.id
        WHERE m.id = match.id
    ) INTO result;

    RETURN result;
END;
$$;
