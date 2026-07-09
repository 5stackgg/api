-- League registration guards + returning-team auto-slotting.

CREATE OR REPLACE FUNCTION public.tbi_league_team_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    season public.league_seasons;
    _session json;
    _role text;
    _steam_id bigint;
    _prior_division_id uuid;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = NEW.league_season_id;

    _session := current_setting('hasura.user', true)::json;
    _role := _session ->> 'x-hasura-role';
    _steam_id := (_session ->> 'x-hasura-user-id')::bigint;

    -- Admins can add teams at any point before the season starts; everyone
    -- else registers while the window is open.
    IF _role IS NULL
       OR public.is_league_admin_for_session(_session) THEN
        IF season.status IN ('Live', 'Playoffs', 'Finished', 'Canceled') THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Season has already started';
        END IF;
    ELSE
        IF season.status != 'RegistrationOpen' THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Registration is not open';
        END IF;
        IF season.signup_opens_at IS NOT NULL AND NOW() < season.signup_opens_at THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Registration has not opened yet';
        END IF;
        IF season.signup_closes_at IS NOT NULL AND NOW() >= season.signup_closes_at THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Registration has closed';
        END IF;

        NEW.status := 'Pending';
    END IF;

    IF NEW.registered_by_steam_id IS NULL THEN
        NEW.registered_by_steam_id := _steam_id;
    END IF;

    IF NEW.captain_steam_id IS NULL THEN
        SELECT COALESCE(t.captain_steam_id, t.owner_steam_id) INTO NEW.captain_steam_id
        FROM public.league_teams lt
        JOIN public.teams t ON t.id = lt.team_id
        WHERE lt.id = NEW.league_team_id;
    END IF;

    -- Division requests are only honored when the league setting allows them;
    -- otherwise teams register with no preference and admins place them.
    IF NEW.requested_division_id IS NOT NULL
       AND COALESCE(
           (SELECT value FROM public.settings WHERE name = 'public.league_allow_division_request'),
           'false'
       ) <> 'true' THEN
        NEW.requested_division_id := NULL;
    END IF;

    -- Returning teams auto-slot into the division their last approved movement
    -- pointed at (admin can still re-place before approval).
    IF NEW.assigned_division_id IS NULL THEN
        SELECT COALESCE(m.final_to_division_id, m.computed_to_division_id)
        INTO _prior_division_id
        FROM public.league_team_movements m
        JOIN public.league_seasons ls ON ls.id = m.league_season_id
        WHERE m.league_team_id = NEW.league_team_id
          AND m.approved_at IS NOT NULL
          AND m.type != 'Remove'
        ORDER BY ls.created_at DESC
        LIMIT 1;

        NEW.assigned_division_id := _prior_division_id;
    END IF;

    -- No prior placement: pre-select the team's requested tier so the admin
    -- starts from the team's preference and can change it.
    IF NEW.assigned_division_id IS NULL
       AND NEW.requested_division_id IS NOT NULL THEN
        NEW.assigned_division_id := NEW.requested_division_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_league_team_seasons ON public.league_team_seasons;
CREATE TRIGGER tbi_league_team_seasons
    BEFORE INSERT ON public.league_team_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_league_team_seasons();

CREATE OR REPLACE FUNCTION public.tbu_league_team_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    season public.league_seasons;
    _roster_count int;
    _session json;
    _is_admin boolean;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = NEW.league_season_id;

    _session := current_setting('hasura.user', true)::json;
    -- Internal sessions (no GUC) and league admins act with admin authority.
    _is_admin := _session ->> 'x-hasura-role' IS NULL
        OR public.is_league_admin_for_session(_session);

    -- Placement is admin-only; captains may only touch their status and
    -- captain designation.
    IF NOT _is_admin
       AND (NEW.assigned_division_id IS DISTINCT FROM OLD.assigned_division_id
            OR NEW.seed IS DISTINCT FROM OLD.seed) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Only a league admin can change placement';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        -- Only admins move a team out of Approved (except self-withdrawal):
        -- an approved team cannot quietly revert itself to Pending and slip
        -- out of materialization.
        IF OLD.status = 'Approved' AND NEW.status != 'Withdrawn' AND NOT _is_admin THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Only a league admin can change an approved registration';
        END IF;

        IF NEW.status = 'Approved' THEN
            IF NEW.assigned_division_id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Assign a division before approving a team';
            END IF;

            SELECT COUNT(*) INTO _roster_count
            FROM public.league_team_rosters
            WHERE league_team_season_id = NEW.id
              AND removed_at IS NULL;
            IF _roster_count < COALESCE(season.min_roster_size, public.team_min_roster_size()) THEN
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Team roster has ' || _roster_count || ' players; the season requires at least ' || COALESCE(season.min_roster_size, public.team_min_roster_size());
            END IF;
        END IF;

        -- Teams cannot self-withdraw once play starts; admins can remove a
        -- dead team (remaining matchups are forfeited via
        -- remove_league_team_from_season).
        IF NEW.status = 'Withdrawn' AND season.status IN ('Live', 'Playoffs', 'Finished')
           AND NOT _is_admin THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot withdraw after the season has started';
        END IF;

        -- A team may re-register a declined/waitlisted/withdrawn registration,
        -- but only back to Pending and only while registration is still open.
        IF NOT _is_admin AND NEW.status = 'Pending' THEN
            IF OLD.status NOT IN ('Declined', 'Waitlisted', 'Withdrawn') THEN
                RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Only a declined, waitlisted or withdrawn registration can be re-registered';
            END IF;
            IF season.status != 'RegistrationOpen' THEN
                RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Registration is not open';
            END IF;
        END IF;

        -- The decline reason surfaces on a declined row and on a revoked
        -- (Withdrawn) row; drop it on any other transition (approve, resubmit).
        IF NEW.status NOT IN ('Declined', 'Withdrawn') THEN
            NEW.decline_reason := NULL;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_league_team_seasons ON public.league_team_seasons;
CREATE TRIGGER tbu_league_team_seasons
    BEFORE UPDATE ON public.league_team_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_league_team_seasons();

-- Approval guarantees the (season, division) instance exists so placement,
-- standings and materialization always have a row to hang off.
CREATE OR REPLACE FUNCTION public.tau_league_team_seasons() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Season existence is re-checked so FK cascades (e.g. tournament deletion
    -- SET NULLing tournament_team_id mid-teardown) can't re-create rows for a
    -- season that is being removed.
    IF NEW.status = 'Approved' AND NEW.assigned_division_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.league_seasons WHERE id = NEW.league_season_id) THEN
        INSERT INTO public.league_season_divisions (league_season_id, league_division_id)
        VALUES (NEW.league_season_id, NEW.assigned_division_id)
        ON CONFLICT (league_season_id, league_division_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_league_team_seasons ON public.league_team_seasons;
CREATE TRIGGER tau_league_team_seasons
    AFTER INSERT OR UPDATE ON public.league_team_seasons
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_league_team_seasons();
