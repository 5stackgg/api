-- Gates the ACTING session against the tournament's minimum role. Delegates to
-- is_above_role so role ordering has exactly one definition; an unrecognised
-- role makes is_above_role return NULL, which is folded to false here so the
-- computed field reads as a denial rather than an absent answer.
CREATE OR REPLACE FUNCTION public.meets_min_role(tournament public.tournaments, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT tournament.min_role IS NULL
        OR COALESCE(public.is_above_role(tournament.min_role, hasura_session), false);
$$;
