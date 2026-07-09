-- Match-time negotiation between the two captains of a league matchup.
-- Either side proposes a time inside the match week's window; when the other
-- side accepts, the agreed time is stamped on the tournament bracket, which
-- the existing scheduling cron then materializes into a real match.

-- The two teams of a bracket the given player manages, if any.
CREATE OR REPLACE FUNCTION public.league_bracket_managed_team(
    _bracket public.tournament_brackets,
    _steam_id bigint
) RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT tt.id
    FROM public.tournament_teams tt
    WHERE tt.id IN (_bracket.tournament_team_id_1, _bracket.tournament_team_id_2)
      AND tt.team_id IS NOT NULL
      AND public.manages_team(tt.team_id, _steam_id)
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.tbi_league_scheduling_proposals() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    bracket public.tournament_brackets;
    _window public.tournament_stage_windows;
    week public.league_match_weeks;
    _session json;
    _role text;
    _steam_id bigint;
    _proposer_team_id uuid;
    _match_status text;
    _is_league boolean;
    _is_negotiated boolean;
BEGIN
    SELECT * INTO bracket FROM public.tournament_brackets WHERE id = NEW.tournament_bracket_id;

    IF bracket.finished = true THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'This matchup can no longer be rescheduled';
    END IF;

    -- Renegotiation is allowed while the created match is still waiting to
    -- be played; once it goes live (or beyond) the time is settled.
    IF bracket.match_id IS NOT NULL THEN
        SELECT m.status INTO _match_status FROM public.matches m WHERE m.id = bracket.match_id;
        IF _match_status NOT IN ('Scheduled', 'WaitingForCheckIn') THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'This matchup can no longer be rescheduled';
        END IF;
    END IF;

    IF bracket.tournament_team_id_1 IS NULL OR bracket.tournament_team_id_2 IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'This matchup does not have both teams yet';
    END IF;

    -- Prefer a generic per-stage window; fall back to the league match week for
    -- league brackets that have not been converged onto windows yet.
    _window := public.tournament_bracket_window(NEW.tournament_bracket_id);
    week := public.league_bracket_match_week(NEW.tournament_bracket_id);

    _is_league := EXISTS (
        SELECT 1
        FROM public.tournament_brackets tb
        JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        JOIN public.league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
        WHERE tb.id = NEW.tournament_bracket_id
    );
    _is_negotiated := EXISTS (
        SELECT 1
        FROM public.tournament_brackets tb
        JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        JOIN public.tournaments t ON t.id = ts.tournament_id
        WHERE tb.id = NEW.tournament_bracket_id
          AND t.scheduling_mode = 'negotiated'
    );

    -- Row-value IS NOT NULL is true only when EVERY field is non-null; a window
    -- with a null opens/closes/default would wrongly skip enforcement. Test the
    -- primary key instead.
    IF _window.id IS NOT NULL THEN
        IF (_window.opens_at IS NOT NULL AND NEW.proposed_time < _window.opens_at)
           OR (_window.closes_at IS NOT NULL AND NEW.proposed_time > _window.closes_at) THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Proposed time is outside the scheduling window';
        END IF;
    ELSIF week.id IS NOT NULL THEN
        IF NEW.proposed_time < week.opens_at OR NEW.proposed_time > week.closes_at THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Proposed time is outside the match week window';
        END IF;
    ELSE
        -- No window (e.g. playoff brackets, or a windowless negotiated stage):
        -- only league or negotiated-scheduling tournaments may negotiate, and
        -- only within the next two weeks.
        IF NOT (_is_league OR _is_negotiated) THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Scheduling proposals only apply to schedulable matchups';
        END IF;

        IF NEW.proposed_time > NOW() + INTERVAL '14 days' THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Matches must be scheduled within the next two weeks';
        END IF;
    END IF;

    IF NEW.proposed_time < NOW() THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Proposed time is in the past';
    END IF;

    _session := current_setting('hasura.user', true)::json;
    _role := _session ->> 'x-hasura-role';
    _steam_id := (_session ->> 'x-hasura-user-id')::bigint;

    IF _role IS NOT NULL AND NOT public.is_league_admin_for_session(_session) THEN
        _proposer_team_id := public.league_bracket_managed_team(bracket, _steam_id);
        IF _proposer_team_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Only the captains of this matchup can propose times';
        END IF;
    END IF;

    IF NEW.proposed_by_steam_id IS NULL THEN
        NEW.proposed_by_steam_id := _steam_id;
    END IF;

    NEW.status := 'Pending';

    IF NEW.proposed_by_league_team_season_id IS NULL AND _proposer_team_id IS NOT NULL THEN
        SELECT lts.id INTO NEW.proposed_by_league_team_season_id
        FROM public.league_team_seasons lts
        WHERE lts.tournament_team_id = _proposer_team_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_league_scheduling_proposals ON public.league_scheduling_proposals;
CREATE TRIGGER tbi_league_scheduling_proposals
    BEFORE INSERT ON public.league_scheduling_proposals
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_league_scheduling_proposals();

CREATE OR REPLACE FUNCTION public.tbu_league_scheduling_proposals() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    bracket public.tournament_brackets;
    _session json;
    _role text;
    _steam_id bigint;
    _responder_team_id uuid;
    _proposer_team_id uuid;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        -- Superseded/Expired are reached only from tau_league_scheduling_proposals
        -- and the schedule cron, which stand this up around their own writes.
        IF current_setting('fivestack.proposal_system_write', true) = 'true' THEN
            RETURN NEW;
        END IF;

        IF OLD.status != 'Pending' THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Only pending proposals can be answered';
        END IF;

        IF NEW.status NOT IN ('Accepted', 'Declined', 'Countered') THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'A proposal can only be accepted, declined or countered';
        END IF;

        SELECT * INTO bracket FROM public.tournament_brackets WHERE id = NEW.tournament_bracket_id;

        _session := current_setting('hasura.user', true)::json;
        _role := _session ->> 'x-hasura-role';
        _steam_id := (_session ->> 'x-hasura-user-id')::bigint;

        IF bracket.finished = true THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'This matchup can no longer be rescheduled';
        END IF;

        IF bracket.match_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.matches m
            WHERE m.id = bracket.match_id
              AND m.status IN ('Scheduled', 'WaitingForCheckIn')
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'This matchup can no longer be rescheduled';
        END IF;

        IF _role IS NOT NULL AND NOT public.is_league_admin_for_session(_session) THEN
            _responder_team_id := public.league_bracket_managed_team(bracket, _steam_id);
            IF _responder_team_id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Only the captains of this matchup can respond';
            END IF;

            -- The proposing side cannot accept its own proposal.
            _proposer_team_id := public.league_bracket_managed_team(bracket, OLD.proposed_by_steam_id);
            IF NEW.status = 'Accepted' AND _responder_team_id = _proposer_team_id THEN
                RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The opposing team must accept the proposal';
            END IF;
        END IF;

        IF NEW.responded_by_steam_id IS NULL THEN
            NEW.responded_by_steam_id := _steam_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_league_scheduling_proposals ON public.league_scheduling_proposals;
CREATE TRIGGER tbu_league_scheduling_proposals
    BEFORE UPDATE ON public.league_scheduling_proposals
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_league_scheduling_proposals();

CREATE OR REPLACE FUNCTION public.tau_league_scheduling_proposals() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _bracket public.tournament_brackets;
BEGIN
    IF NEW.status = 'Accepted' AND OLD.status = 'Pending' THEN
        -- Stamp the agreed time. For brackets whose match already exists in
        -- WaitingForCheckIn, tau_tournament_brackets syncs it back to Scheduled.
        UPDATE public.tournament_brackets
        SET scheduled_at = NEW.proposed_time
        WHERE id = NEW.tournament_bracket_id
        RETURNING * INTO _bracket;

        -- Materialize the match now (as 'Scheduled', not check-in) so it links
        -- to the tournament/league and shows on team calendars immediately.
        -- CheckForScheduledMatches opens check-in ~15m before kickoff.
        IF _bracket.match_id IS NULL
           AND _bracket.finished = false
           AND _bracket.tournament_team_id_1 IS NOT NULL
           AND _bracket.tournament_team_id_2 IS NOT NULL THEN
            PERFORM set_config('fivestack.schedule_as_pending', 'true', true);
            PERFORM public.schedule_tournament_match(_bracket);
            PERFORM set_config('fivestack.schedule_as_pending', 'false', true);
        END IF;

        -- Matches still in Scheduled are not covered by the bracket sync.
        UPDATE public.matches m
        SET scheduled_at = NEW.proposed_time
        FROM public.tournament_brackets tb
        WHERE tb.id = NEW.tournament_bracket_id
          AND m.id = tb.match_id
          AND m.status = 'Scheduled';

        PERFORM set_config('fivestack.proposal_system_write', 'true', true);
        UPDATE public.league_scheduling_proposals
        SET status = 'Superseded'
        WHERE tournament_bracket_id = NEW.tournament_bracket_id
          AND id != NEW.id
          AND status = 'Pending';
        PERFORM set_config('fivestack.proposal_system_write', 'false', true);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_league_scheduling_proposals ON public.league_scheduling_proposals;
CREATE TRIGGER tau_league_scheduling_proposals
    AFTER UPDATE ON public.league_scheduling_proposals
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_league_scheduling_proposals();
