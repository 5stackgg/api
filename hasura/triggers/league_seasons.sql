-- League season status machine.
-- Setup -> RegistrationOpen -> RegistrationClosed -> Live -> Playoffs -> Finished
-- Canceled is reachable from any pre-Finished status. RegistrationClosed can
-- reopen. Guards run BEFORE update; effects (tournament materialization,
-- cancellation, movement computation) run AFTER.

-- Seasons cannot run concurrently: a season's window is [signup open (or
-- start), start + match weeks]. Reject one that overlaps another season that
-- isn't Canceled or Finished. Seasons without a start date yet are unscheduled
-- and skipped.
CREATE OR REPLACE FUNCTION public.assert_league_season_no_overlap(
    _season public.league_seasons
) RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _start timestamptz;
    _end timestamptz;
BEGIN
    IF _season.starts_at IS NULL THEN
        RETURN;
    END IF;

    _start := COALESCE(_season.signup_opens_at, _season.starts_at);
    _end := _season.starts_at + (_season.match_weeks_count * INTERVAL '7 days');

    IF EXISTS (
        SELECT 1 FROM public.league_seasons s
        WHERE s.id <> _season.id
          AND s.status NOT IN ('Canceled', 'Finished')
          AND s.starts_at IS NOT NULL
          AND _start < s.starts_at + (s.match_weeks_count * INTERVAL '7 days')
          AND COALESCE(s.signup_opens_at, s.starts_at) < _end
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Season dates overlap another season that is still scheduled';
    END IF;
END;
$$;

-- Seasons auto-number: there is one global league, so each new season gets the
-- next sequential number and a derived "Season N" name (no hand-typed name).
CREATE OR REPLACE FUNCTION public.tbi_league_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.season_number IS NULL THEN
        SELECT COALESCE(MAX(season_number), 0) + 1
        INTO NEW.season_number
        FROM public.league_seasons;
    END IF;

    IF NEW.name IS NULL OR btrim(NEW.name) = '' THEN
        NEW.name := 'Season ' || NEW.season_number;
    END IF;

    IF NEW.status NOT IN ('Canceled', 'Finished') THEN
        PERFORM public.assert_league_season_no_overlap(NEW);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_league_seasons ON public.league_seasons;
CREATE TRIGGER tbi_league_seasons
    BEFORE INSERT ON public.league_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_league_seasons();

CREATE OR REPLACE FUNCTION public.tbu_league_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _week_count int;
    _division_count int;
BEGIN
    -- Bracket structure is generated at season start; the playoff format
    -- (elimination type, third-place decider) cannot change afterwards.
    -- Series best-of remains editable at any time.
    IF (NEW.playoff_stage_type IS DISTINCT FROM OLD.playoff_stage_type
        OR NEW.playoff_third_place_match IS DISTINCT FROM OLD.playoff_third_place_match)
       AND OLD.status IN ('Live', 'Playoffs', 'Finished') THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The playoff format cannot change after the season has started';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        -- restart_league_season revives a Canceled season back to Live; it sets
        -- this bypass so the terminal-status and source-status guards stand aside.
        IF OLD.status IN ('Finished', 'Canceled')
           AND current_setting('fivestack.league_restart', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'Cannot change the status of a ' || OLD.status || ' league season';
        END IF;

        CASE NEW.status
            WHEN 'RegistrationOpen' THEN
                IF OLD.status NOT IN ('Setup', 'RegistrationClosed') THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Registration can only open from Setup';
                END IF;
            WHEN 'RegistrationClosed' THEN
                IF OLD.status != 'RegistrationOpen' THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Registration is not open';
                END IF;
            WHEN 'Live' THEN
                IF OLD.status != 'RegistrationClosed'
                   AND current_setting('fivestack.league_restart', true) IS DISTINCT FROM 'true' THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Season can only start from RegistrationClosed';
                END IF;

                IF NEW.match_options_id IS NULL THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Season needs a match options template before starting';
                END IF;

                SELECT COUNT(*) INTO _week_count
                FROM league_match_weeks WHERE league_season_id = NEW.id;
                IF _week_count < NEW.match_weeks_count THEN
                    RAISE EXCEPTION USING ERRCODE = '22000',
                        MESSAGE = 'Season defines ' || NEW.match_weeks_count || ' match weeks but only ' || _week_count || ' are configured';
                END IF;

                -- Teams that fell below the minimum roster (players left after
                -- approval) are revoked at kickoff. They were warned while
                -- registration was open/closed. Runs before the division count
                -- so a division dropping below four is correctly skipped.
                UPDATE public.league_team_seasons lts
                SET status = 'Withdrawn',
                    decline_reason = 'Roster fell below the minimum of '
                        || COALESCE(NEW.min_roster_size, public.team_min_roster_size())
                        || ' players before the league started'
                WHERE lts.league_season_id = NEW.id
                  AND lts.status = 'Approved'
                  AND (
                      SELECT COUNT(*)
                      FROM public.league_team_rosters ltr
                      WHERE ltr.league_team_season_id = lts.id
                        AND ltr.removed_at IS NULL
                  ) < COALESCE(NEW.min_roster_size, public.team_min_roster_size());

                -- At least one division must be able to run (tournament stages
                -- require a minimum of 4 teams per group).
                SELECT COUNT(*) INTO _division_count
                FROM (
                    SELECT lts.assigned_division_id
                    FROM league_team_seasons lts
                    WHERE lts.league_season_id = NEW.id
                      AND lts.status = 'Approved'
                      AND lts.assigned_division_id IS NOT NULL
                    GROUP BY lts.assigned_division_id
                    HAVING COUNT(*) >= 4
                ) runnable;
                IF _division_count < 1 THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Season needs at least one division with four or more approved teams';
                END IF;
            WHEN 'Playoffs' THEN
                IF OLD.status != 'Live' THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Playoffs can only start from a live season';
                END IF;
            WHEN 'Finished' THEN
                IF OLD.status NOT IN ('Live', 'Playoffs') THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Season can only finish from Live or Playoffs';
                END IF;
            WHEN 'Setup' THEN
                IF OLD.status != 'RegistrationOpen' THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Season can only return to Setup from RegistrationOpen';
                END IF;
            WHEN 'Canceled' THEN
                -- Any pre-Finished status may cancel.
            ELSE
                -- No structural guard for other transitions.
        END CASE;
    END IF;

    -- Re-validate scheduling when the window moves (or a season is revived).
    IF NEW.status NOT IN ('Canceled', 'Finished')
       AND (NEW.signup_opens_at IS DISTINCT FROM OLD.signup_opens_at
            OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
            OR NEW.match_weeks_count IS DISTINCT FROM OLD.match_weeks_count
            OR NEW.status IS DISTINCT FROM OLD.status) THEN
        PERFORM public.assert_league_season_no_overlap(NEW);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_league_seasons ON public.league_seasons;
CREATE TRIGGER tbu_league_seasons
    BEFORE UPDATE ON public.league_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_league_seasons();

CREATE OR REPLACE FUNCTION public.tau_league_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Series-format edits propagate to the live division stages; only
    -- matches that have not materialized yet pick up the new best-of
    -- (same semantics as tournament per-round configuration).
    IF NEW.week_best_of IS DISTINCT FROM OLD.week_best_of THEN
        UPDATE public.tournament_stages ts
        SET settings = COALESCE(ts.settings, '{}'::jsonb) - 'round_best_of'
            || COALESCE(public.league_round_best_of_settings(NEW.week_best_of), '{}'::jsonb)
        FROM public.league_season_divisions lsd
        WHERE lsd.league_season_id = NEW.id
          AND ts.tournament_id = lsd.tournament_id
          AND ts."order" = 1;
    END IF;

    IF NEW.playoff_round_best_of IS DISTINCT FROM OLD.playoff_round_best_of THEN
        UPDATE public.tournament_stages ts
        SET settings = COALESCE(ts.settings, '{}'::jsonb) - 'round_best_of'
            || COALESCE(public.league_playoff_best_of_settings(NEW.playoff_round_best_of), '{}'::jsonb)
        FROM public.league_season_divisions lsd
        WHERE lsd.league_season_id = NEW.id
          AND ts.tournament_id = lsd.tournament_id
          AND ts."order" = 2;
    END IF;

    IF NEW.default_best_of IS DISTINCT FROM OLD.default_best_of THEN
        UPDATE public.tournament_stages ts
        SET default_best_of = NEW.default_best_of
        FROM public.league_season_divisions lsd
        WHERE lsd.league_season_id = NEW.id
          AND ts.tournament_id = lsd.tournament_id
          AND ts."order" = 1;
    END IF;

    IF NEW.playoff_best_of IS DISTINCT FROM OLD.playoff_best_of THEN
        UPDATE public.tournament_stages ts
        SET default_best_of = NEW.playoff_best_of
        FROM public.league_season_divisions lsd
        WHERE lsd.league_season_id = NEW.id
          AND ts.tournament_id = lsd.tournament_id
          AND ts."order" = 2;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'Live' THEN
            PERFORM public.start_league_season(NEW.id);
        ELSIF NEW.status = 'Canceled' THEN
            -- Cancelling the season is the sanctioned way to cancel its
            -- tournaments; bypass the league-ownership guard on tbu_tournaments.
            PERFORM set_config('fivestack.league_cascade', 'true', true);
            UPDATE public.tournaments t
            SET status = 'Cancelled'
            FROM public.league_season_divisions lsd
            WHERE lsd.league_season_id = NEW.id
              AND t.id = lsd.tournament_id
              AND t.status NOT IN ('Finished', 'Cancelled', 'CancelledMinTeams');
            UPDATE public.tournaments t
            SET status = 'Cancelled'
            FROM public.league_relegation_playoffs rp
            WHERE rp.league_season_id = NEW.id
              AND t.id = rp.tournament_id
              AND t.status NOT IN ('Finished', 'Cancelled', 'CancelledMinTeams');
            PERFORM set_config('fivestack.league_cascade', 'false', true);
        ELSIF NEW.status = 'Finished' THEN
            PERFORM public.finish_league_season(NEW.id);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_league_seasons ON public.league_seasons;
CREATE TRIGGER tau_league_seasons
    AFTER UPDATE ON public.league_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_league_seasons();

-- A league owns its division/playoff tournaments; deleting the season must take
-- them with it, otherwise they orphan (their league_season_division link is
-- cascade-removed) and resurface in the public tournament lists. Runs BEFORE the
-- season row is deleted, while the division/playoff rows still resolve.
CREATE OR REPLACE FUNCTION public.tbd_league_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament_ids uuid[];
BEGIN
    SELECT array_agg(tid) INTO _tournament_ids
    FROM (
        SELECT tournament_id AS tid FROM public.league_season_divisions
        WHERE league_season_id = OLD.id AND tournament_id IS NOT NULL
        UNION
        SELECT tournament_id FROM public.league_relegation_playoffs
        WHERE league_season_id = OLD.id AND tournament_id IS NOT NULL
    ) x;

    IF _tournament_ids IS NOT NULL THEN
        -- The league owns these tournaments; stand aside from the delete guard.
        PERFORM set_config('fivestack.league_cascade', 'true', true);

        -- Drop per-team roster links so cascading tournament_teams don't trip.
        UPDATE public.league_team_seasons
        SET tournament_team_id = NULL
        WHERE league_season_id = OLD.id;

        -- League matches are dormant/Scheduled until played (no demos yet); a
        -- season with real results should be Finished, not deleted. Remove the
        -- matches, then the tournaments themselves.
        DELETE FROM public.matches m
        USING public.tournament_brackets tb
        INNER JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = ANY(_tournament_ids)
          AND m.id = tb.match_id;

        DELETE FROM public.tournaments WHERE id = ANY(_tournament_ids);

        PERFORM set_config('fivestack.league_cascade', 'false', true);
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_league_seasons ON public.league_seasons;
CREATE TRIGGER tbd_league_seasons
    BEFORE DELETE ON public.league_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_league_seasons();

-- A season's match_options template is owned by the season; GC it on delete.
CREATE OR REPLACE FUNCTION public.tad_league_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.cleanup_orphaned_match_options(OLD.match_options_id);
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_league_seasons ON public.league_seasons;
CREATE TRIGGER tad_league_seasons
    AFTER DELETE ON public.league_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_league_seasons();
