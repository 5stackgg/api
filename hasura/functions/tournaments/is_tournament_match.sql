CREATE OR REPLACE FUNCTION public.is_tournament_match(match public.matches)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournament_brackets tb
        WHERE tb.match_id = match.id
    );
$$;
