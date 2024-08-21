CREATE OR REPLACE FUNCTION public.match_cancels_at(match public.matches)
RETURNS timestamptz
LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    RETURN match.scheduled_at + INTERVAL '15 minutes';
END;
$$;
