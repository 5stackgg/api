-- One-way latch: once the window has opened it stays "started" for the rest of
-- the tournament's life, even after the window closes again. Takes a ROW rather
-- than an id so tbu_tournaments can hand it OLD -- deciding from NEW would let
-- the same statement push `start` into the future and unlock itself.
CREATE OR REPLACE FUNCTION public.tournament_check_in_started(tournament public.tournaments)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT tournament.check_in_required
       AND (
           tournament.check_in_ends_at IS NOT NULL
           OR now() >= tournament.start - make_interval(mins => tournament.check_in_opens_before_minutes)
       );
$$;

-- Currently accepting check-ins. check_in_ends_at is authoritative once
-- stamped: the job that opens the window freezes the deadline there, so moving
-- `start` afterwards cannot drag the closing time with it.
CREATE OR REPLACE FUNCTION public.tournament_check_in_open(tournament public.tournaments)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT public.tournament_check_in_started(tournament)
       AND now() < COALESCE(
           tournament.check_in_ends_at,
           tournament.start - make_interval(mins => tournament.check_in_closes_before_minutes)
       );
$$;

-- How many registered teams missed a required check-in. The web review panel
-- reads this instead of re-deriving "required AND started AND checked_in_at IS
-- NULL" client-side, which is the rule that would drift first.
CREATE OR REPLACE FUNCTION public.tournament_missed_check_in_count(tournament public.tournaments)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN NOT tournament.check_in_required
          OR NOT public.tournament_check_in_started(tournament)
        THEN 0
        ELSE (
            SELECT COUNT(*)::int
            FROM public.tournament_teams tt
            WHERE tt.tournament_id = tournament.id
              AND tt.checked_in_at IS NULL
        )
    END;
$$;

-- Whether the team currently satisfies the tournament's check-in requirement.
-- Reads only tournament_teams.checked_in_at, which is the single signal the rest
-- of the system respects: in Players mode a roster trigger rolls the individual
-- confirmations up into it, so no caller ever has to branch on the mode.
CREATE OR REPLACE FUNCTION public.tournament_team_checked_in(team public.tournament_teams)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT NOT t.check_in_required OR team.checked_in_at IS NOT NULL
    FROM public.tournaments t
    WHERE t.id = team.tournament_id;
$$;
