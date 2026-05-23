CREATE OR REPLACE FUNCTION public.get_match_effective_at(match public.matches)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(match.started_at, match.scheduled_at, match.created_at);
$$;
