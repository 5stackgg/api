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

-- Whether a check-in window was ever actually OPENED, which is not the same
-- question as tournament_check_in_started: that one also answers true the
-- moment the clock passes start - opens_before, whether or not anything opened.
-- Only ProcessTournamentCheckIn (or an organizer extending) stamps
-- check_in_ends_at, so this is the only honest basis for treating a team as a
-- no-show. Nobody misses a prompt that never appeared: with the derived form,
-- an organizer who closed registration early -- so the open pass, which only
-- fires on RegistrationOpen, never ran -- would watch a fully rostered field
-- drop to zero eligible teams and self-cancel as CancelledMinTeams.
CREATE OR REPLACE FUNCTION public.tournament_check_in_window_opened(tournament public.tournaments)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT tournament.check_in_required AND tournament.check_in_ends_at IS NOT NULL;
$$;

-- Whether the team could be seeded at all, check-in aside -- the same roster
-- test assign_seeds_to_teams applies. Deliberately not eligible_at: that column
-- is recomputed with the check-in gate folded in, so a single re-admit (which
-- re-runs the seeding) would silently shrink any count built on it.
CREATE OR REPLACE FUNCTION public.tournament_team_lineup_filled(team public.tournament_teams)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT (
        SELECT COUNT(*)
        FROM public.tournament_team_roster ttr
        WHERE ttr.tournament_team_id = team.id
    ) >= public.tournament_min_players_per_lineup(t)
    FROM public.tournaments t
    WHERE t.id = team.tournament_id;
$$;

-- How many registered teams missed a required check-in. The web review panel
-- reads this instead of re-deriving "window opened AND checked_in_at IS NULL"
-- client-side, which is the rule that would drift first. Only teams that would
-- otherwise have been seeded count: a half-filled roster is not seedable with
-- or without a check-in, so counting it would report a no-show that changes
-- nothing and hold the tournament for a review with nothing to decide.
CREATE OR REPLACE FUNCTION public.tournament_missed_check_in_count(tournament public.tournaments)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN NOT public.tournament_check_in_window_opened(tournament)
        THEN 0
        ELSE (
            SELECT COUNT(*)::int
            FROM public.tournament_teams tt
            WHERE tt.tournament_id = tournament.id
              AND tt.checked_in_at IS NULL
              AND public.tournament_team_lineup_filled(tt)
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
