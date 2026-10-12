CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
BEGIN
    -- Max players only on joining: a lowered cap must not block a roster shedding players.
    IF TG_OP = 'DELETE' THEN
        PERFORM check_team_eligibility(OLD, false);
    ELSIF TG_OP = 'INSERT' THEN
        PERFORM check_team_eligibility(NEW, true);
    ELSE
        PERFORM check_team_eligibility(NEW, NEW.tournament_team_id IS DISTINCT FROM OLD.tournament_team_id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiud_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER taiud_tournament_team_roster AFTER INSERT OR UPDATE OR DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tbd_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _min_players int;
    _roster_count int;
BEGIN
    SELECT t.* INTO _tournament
        FROM tournament_teams tt
        JOIN tournaments t ON t.id = tt.tournament_id
        WHERE tt.id = OLD.tournament_team_id;

    -- When the whole team (or the tournament) is being deleted its
    -- tournament_teams row is already gone by the time this cascade fires, so
    -- the join finds nothing and we let the roster rows cascade through.
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    -- Rosters are only locked once the bracket has been seeded. Before that
    -- (Setup / RegistrationOpen) teams edit their lineup freely and dropping
    -- below the minimum just makes them ineligible.
    IF _tournament.status NOT IN ('RegistrationClosed', 'Live', 'Paused') THEN
        RETURN OLD;
    END IF;

    -- The team row serializes two removals, so neither counts the other's
    -- player as still there. The key must stay promote_tournament_free_agent's:
    -- a removal runs that promotion after this, and the promotion takes its lock
    -- before the team row, so taking it here first keeps the order the same.
    PERFORM pg_advisory_xact_lock(
        hashtext('tournament_free_agent_promotion'),
        hashtext(_tournament.id::text)
    );

    PERFORM 1
        FROM tournament_teams tt
        WHERE tt.id = OLD.tournament_team_id
        FOR NO KEY UPDATE;

    _min_players := tournament_min_players_per_lineup(_tournament);

    SELECT COUNT(*) INTO _roster_count
        FROM tournament_team_roster ttr
        WHERE ttr.tournament_team_id = OLD.tournament_team_id;

    -- Removing this player would strip the team's eligibility and seed while the
    -- tournament is underway. A team can only swap a player out if it has a
    -- substitute keeping it at or above the minimum lineup.
    IF _roster_count - 1 < _min_players THEN
        RAISE EXCEPTION USING
            ERRCODE = '22000',
            MESSAGE = 'Cannot remove player: the team would drop below the minimum lineup of ' || _min_players || ' players while the tournament is underway';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER tbd_tournament_team_roster BEFORE DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.tbd_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tbi_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _session json;
    _team public.tournament_teams;
    _tournament public.tournaments;
    _organizer boolean;
    _invite boolean := false;
BEGIN
    -- The team row before the roster key, on every path. The maximum lineup is
    -- counted after the insert (check_team_eligibility), so two inserts that
    -- each count without the other's row would both pass; and a transfer
    -- seating the new owner (tau_tournament_team_owner) already holds this row
    -- when it inserts, so taking the key first here deadlocks against it.
    PERFORM 1
        FROM tournament_teams tt
        WHERE tt.id = NEW.tournament_team_id
        FOR NO KEY UPDATE;

    -- draft_tournament_free_agent_teams builds pickup teams out of players who
    -- never invited each other, so the invite redirect below would turn every
    -- generated roster row into an invitation nobody sent and leave the teams
    -- empty. The named GUC marks that system path the same way
    -- fivestack.league_cascade does, and is checked before hasura.user is read
    -- so the draft also works from a jobs/cron connection with no session.
    IF current_setting('fivestack.free_agent_draft', true) = 'true' THEN
        RETURN NEW;
    END IF;

    _session := current_setting('hasura.user')::json;

    IF _session ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer') THEN
        RETURN NEW;
    END IF;

    SELECT * INTO _team FROM tournament_teams WHERE id = NEW.tournament_team_id;

    IF _team.tournament_id IS DISTINCT FROM NEW.tournament_id THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'That team is not in this tournament';
    END IF;

    -- Gates the player being ADDED, not the session adding them: a captain
    -- fills a roster with other people, so checking only the actor lets any of
    -- them past the tournament's role and ELO limits.
    IF NOT public.player_meets_tournament_requirements(NEW.tournament_id, NEW.player_steam_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Player does not meet this tournament''s entry requirements';
    END IF;

    SELECT * INTO _tournament FROM tournaments WHERE id = NEW.tournament_id;
    _organizer := public.is_tournament_organizer(_tournament, _session);

    IF _team.team_id IS NULL THEN
        IF _team.owner_steam_id = NEW.player_steam_id THEN
            NEW.role = 'Admin';
            RETURN NEW;
        END IF;

        _invite := true;
    -- A team-backed roster takes a player with no invite at all, so somebody
    -- from outside the team is a force-add rather than a lineup pick.
    ELSIF NOT EXISTS (
        SELECT 1 FROM team_roster tr
        WHERE tr.team_id = _team.team_id AND tr.player_steam_id = NEW.player_steam_id
    ) THEN
        -- A free agent signed up to be drafted, not to be put on whichever team
        -- picks them, so a captain's force-add becomes an invite they answer.
        _invite := NOT _organizer AND EXISTS (
            SELECT 1 FROM tournament_free_agents fa
            WHERE fa.tournament_id = NEW.tournament_id
              AND fa.player_steam_id = NEW.player_steam_id
              AND fa.status IN ('registered', 'waitlisted')
        );

        IF NOT _invite THEN
            PERFORM public.assert_session_not_blocked(NEW.player_steam_id, 'tournament_organizer');
        END IF;
    END IF;

    IF NOT _invite THEN
        RETURN NEW;
    END IF;

    -- Hasura checks an insert's permission against the rows it returns, and a
    -- redirected insert returns none, so the invite repeats that check here.
    IF _tournament.status NOT IN ('Setup', 'RegistrationOpen')
       OR NOT (_organizer OR public.can_manage_tournament_team(_team, _session)) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'You cannot add players to this team';
    END IF;

    INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
        VALUES (NEW.tournament_team_id, NEW.player_steam_id, (_session ->> 'x-hasura-user-id')::bigint);

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER tbi_tournament_team_roster BEFORE INSERT ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_roster();

-- Dropped before it is rebuilt: the function grew a DELETE path and with it a
-- new name, and the old pair would otherwise both survive a re-apply.
DROP TRIGGER IF EXISTS taiu_tournament_team_roster_check_in ON public.tournament_team_roster;
DROP TRIGGER IF EXISTS taiud_tournament_team_roster_check_in ON public.tournament_team_roster;
DROP FUNCTION IF EXISTS public.taiu_tournament_team_roster_check_in();

CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster_check_in() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _tournament_id uuid;
    _tournament_team_id uuid;
    _confirmation_lost boolean;
    _min_players int;
    _checked_in int;
BEGIN
    -- Only a real change to this player's own confirmation can move the team's
    -- rollup. Recomputing on every roster write would let adding a substitute
    -- wipe a checked-in (or organizer re-admitted) team.
    IF TG_OP = 'UPDATE' AND NEW.checked_in_at IS NOT DISTINCT FROM OLD.checked_in_at THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.checked_in_at IS NULL THEN
        RETURN NEW;
    END IF;

    -- Dropping a confirmed player is a withdrawn confirmation with the row
    -- removed: the count it was part of is gone either way, so a team that
    -- falls back under the minimum lineup has to lose its roll-up here too.
    -- Left to the UPDATE path alone, a captain could seed an unconfirmed lineup
    -- into the bracket simply by removing the people who confirmed it.
    IF TG_OP = 'DELETE' THEN
        IF OLD.checked_in_at IS NULL THEN
            RETURN OLD;
        END IF;

        _tournament_id := OLD.tournament_id;
        _tournament_team_id := OLD.tournament_team_id;
        _confirmation_lost := true;
    ELSE
        _tournament_id := NEW.tournament_id;
        _tournament_team_id := NEW.tournament_team_id;
        _confirmation_lost := NEW.checked_in_at IS NULL;
    END IF;

    SELECT t.* INTO _tournament
      FROM public.tournaments t
     WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Captains and Admin modes stamp tournament_teams.checked_in_at directly;
    -- per-player rows carry no authority there.
    IF NOT _tournament.check_in_required OR _tournament.check_in_setting <> 'Players' THEN
        RETURN NULL;
    END IF;

    -- The bar is the MINIMUM LINEUP, not the whole roster: a roster of seven
    -- (five starters plus two substitutes) only fields five, and a substitute
    -- who is not playing must not be able to hold the team out of the bracket.
    _min_players := tournament_min_players_per_lineup(_tournament);

    SELECT COUNT(*) INTO _checked_in
      FROM public.tournament_team_roster ttr
     WHERE ttr.tournament_team_id = _tournament_team_id
       AND ttr.checked_in_at IS NOT NULL;

    IF _checked_in >= _min_players THEN
        UPDATE public.tournament_teams tt
           SET checked_in_at = now()
         WHERE tt.id = _tournament_team_id
           AND tt.checked_in_at IS NULL;

    -- Clearing is only ever a LOST confirmation breaking a roll-up that was
    -- already satisfied -- this row went from stamped to NULL (or left the
    -- roster stamped), so the count was _checked_in + 1 a moment ago. A player
    -- CHECKING IN can only raise the count, and reacting to that would let the
    -- first player to confirm wipe a team the registration auto-stamp or an
    -- organizer re-admit had already checked in: they would harm their own team
    -- by doing what the UI asked.
    ELSIF _confirmation_lost AND _checked_in + 1 >= _min_players THEN
        UPDATE public.tournament_teams tt
           SET checked_in_at = NULL
         WHERE tt.id = _tournament_team_id
           AND tt.checked_in_at IS NOT NULL;
    END IF;

    RETURN NULL;
END;
$$;

-- UPDATE OF checked_in_at, but DELETE unqualified: a delete carries no column
-- list to narrow on, and the row taking its stamp with it is exactly the case
-- the clear branch exists for.
CREATE TRIGGER taiud_tournament_team_roster_check_in
    AFTER INSERT OR DELETE OR UPDATE OF checked_in_at ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.taiud_tournament_team_roster_check_in();

CREATE OR REPLACE FUNCTION public.taid_tournament_team_roster_lineups() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _heir bigint;
    _min_players int;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- The team's own captain and owner are its registration defaults (see
        -- tbi_tournament_team), so they take the captaincy back first.
        SELECT ttr.player_steam_id INTO _heir
        FROM tournament_teams tt
        INNER JOIN tournament_team_roster ttr ON ttr.tournament_team_id = tt.id
        INNER JOIN players p ON p.steam_id = ttr.player_steam_id
        LEFT JOIN teams t ON t.id = tt.team_id
        WHERE tt.id = OLD.tournament_team_id
          AND tt.captain_steam_id = OLD.player_steam_id
          AND NOT is_banned(p)
        ORDER BY COALESCE(ttr.player_steam_id = t.captain_steam_id, false) DESC,
                 COALESCE(ttr.player_steam_id = tt.owner_steam_id, false) DESC,
                 ttr.role = 'Admin' DESC,
                 ttr.player_steam_id
        LIMIT 1;

        IF _heir IS NOT NULL THEN
            UPDATE tournament_teams
            SET captain_steam_id = _heir
            WHERE id = OLD.tournament_team_id;
        END IF;
    END IF;

    PERFORM refresh_unstarted_tournament_team_lineups(COALESCE(NEW.tournament_team_id, OLD.tournament_team_id), false);

    IF TG_OP <> 'DELETE' THEN
        RETURN NULL;
    END IF;

    -- The refresh leaves a lineup it cannot keep at the minimum as it is. That
    -- takes a rostered player the lineup cannot seat -- banned, or standing in
    -- for the other side -- since the roster lock counts them all the same. The
    -- removed player would then keep a seat in a match they are no longer
    -- rostered for. A banned player may always go, since that is how a full
    -- roster makes room for a replacement.
    SELECT match_min_players_per_lineup(m)
      INTO _min_players
      FROM tournament_teams tt
      INNER JOIN tournaments t ON t.id = tt.tournament_id
      INNER JOIN tournament_stages ts ON ts.tournament_id = t.id
      INNER JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
      INNER JOIN matches m ON m.id = tb.match_id
      INNER JOIN match_lineup_players mlp
         ON mlp.match_lineup_id = CASE
                WHEN tb.tournament_team_id_1 = tt.id THEN m.lineup_1_id
                ELSE m.lineup_2_id
            END
      INNER JOIN players p ON p.steam_id = mlp.steam_id
     WHERE tt.id = OLD.tournament_team_id
       AND t.status IN ('RegistrationClosed', 'Live', 'Paused')
       AND tt.id IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
       AND m.status IN ('Scheduled', 'WaitingForCheckIn')
       AND mlp.steam_id = OLD.player_steam_id
       AND NOT is_banned(p)
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '22000',
            MESSAGE = 'Cannot remove player: an unstarted match still needs them for its minimum lineup of ' || _min_players
                || ' players. Add a replacement first; if the roster is full, remove a player who cannot be seated in that match (banned, or playing for the other side)';
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taid_tournament_team_roster_lineups ON public.tournament_team_roster;
CREATE TRIGGER taid_tournament_team_roster_lineups
    AFTER INSERT OR DELETE ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.taid_tournament_team_roster_lineups();
