CREATE OR REPLACE FUNCTION public.tbi_tournament_team()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
DECLARE
    tournament tournaments;
    _team_captain_steam_id bigint;
    _session_steam_id bigint;
    _session json;
BEGIN
    SELECT * INTO tournament
    FROM tournaments
    WHERE id = NEW.tournament_id;

    _session_steam_id = nullif(current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id', '')::bigint;
    _session := nullif(current_setting('hasura.user', true), '')::json;

    -- A session with no role is an internal write (a cascade, a job, the
    -- free-agent draft). Those were unrestricted before this guard existed and
    -- stay unrestricted, so only a real request is gated -- the same shape
    -- tbd_tournament_team uses.
    IF (_session ->> 'x-hasura-role') IS NOT NULL
       AND tournament.invite_only
       AND NOT is_tournament_organizer(tournament, _session)
       AND NOT public.tournament_registration_unlocked(NEW.tournament_id, _session_steam_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This tournament is invite only';
    END IF;

    IF NEW.team_id IS NOT NULL THEN
       SELECT owner_steam_id, captain_steam_id
       INTO NEW.owner_steam_id, _team_captain_steam_id
       FROM teams
       WHERE id = NEW.team_id;

       -- If the explicit captain isn't on the team's roster (e.g. an organizer
       -- adding someone else's team), fall back to the team's own captain/owner
       -- so the after-insert roster check doesn't fail.
       IF NEW.captain_steam_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM team_roster tr
               WHERE tr.team_id = NEW.team_id
                 AND tr.player_steam_id = NEW.captain_steam_id
           ) THEN
           NEW.captain_steam_id = NULL;
       END IF;

       IF NEW.captain_steam_id IS NULL THEN
           NEW.captain_steam_id = COALESCE(_team_captain_steam_id, NEW.owner_steam_id, _session_steam_id);
       END IF;
    ELSIF NEW.captain_steam_id IS NULL THEN
       NEW.captain_steam_id = COALESCE(NEW.owner_steam_id, _session_steam_id);
    END IF;

    -- Registering after the window opened counts as checked in: a team that
    -- signs up at T-30 must not be swept at T-15 for failing to confirm a
    -- prompt it was never shown.
    IF NEW.checked_in_at IS NULL AND public.tournament_check_in_open(tournament) THEN
        NEW.checked_in_at = now();
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbi_tournament_team ON public.tournament_teams;
CREATE TRIGGER tbi_tournament_team BEFORE INSERT ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team();


CREATE OR REPLACE FUNCTION public.tbd_tournament_team()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tournament tournaments;
    _session json;
BEGIN
    SELECT *
    INTO tournament
    FROM tournaments
    WHERE id = OLD.tournament_id;

    -- If tournament doesn't exist (cascade delete), allow the team removal
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    IF tournament.status IN ('Cancelled', 'CancelledMinTeams', 'Finished') THEN
        RAISE EXCEPTION 'Cannot leave an active tournament' USING ERRCODE = '22000';
    END IF;

    _session := nullif(current_setting('hasura.user', true), '')::json;

    -- Check-in tournaments only. Withdrawing from a drawn bracket was open to
    -- every player before this feature existed, and check-in is the only thing
    -- that changed: a tournament with check_in_required false must behave
    -- exactly as it did.
    --
    -- A session with no role is an internal write (a cascade, a job, a test
    -- harness that reset hasura.user). Those were unrestricted before this
    -- guard existed and stay unrestricted, so only a real request is gated.
    IF (_session ->> 'x-hasura-role') IS NOT NULL
       AND tournament.check_in_required
       AND tournament.status IN ('RegistrationClosed', 'Live', 'Paused')
       AND NOT is_tournament_organizer(tournament, _session) THEN
        RAISE EXCEPTION 'Cannot withdraw a team once the bracket has been drawn' USING ERRCODE = '22000';
    END IF;

    RETURN OLD;
END;
$$;


DROP TRIGGER IF EXISTS tbd_tournament_team ON public.tournament_teams;
CREATE TRIGGER tbd_tournament_team BEFORE DELETE ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tbd_tournament_team();

CREATE OR REPLACE FUNCTION public.tai_tournament_team()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    max_players_per_lineup INT;
    player_steam_id BIGINT;
BEGIN
    -- When the client already provided a roster selection (e.g. picking a
    -- subset so an A team and B team can share members), leave it as-is.
    -- Otherwise auto-fill the lineup from the team roster.
    IF NEW.team_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM tournament_team_roster ttr
           WHERE ttr.tournament_team_id = NEW.id
       ) THEN

        SELECT tournament_max_players_per_lineup(t)
        INTO max_players_per_lineup
        FROM tournaments t
        WHERE t.id = NEW.tournament_id;

        FOR player_steam_id IN
            SELECT tr.player_steam_id
            FROM team_roster tr
            INNER JOIN teams t ON t.id = tr.team_id
            LEFT JOIN tournament_team_roster ttr
                ON ttr.player_steam_id = tr.player_steam_id
               AND ttr.tournament_id = NEW.tournament_id
            WHERE tr.team_id = NEW.team_id
              AND ttr.player_steam_id IS NULL
            ORDER BY
                CASE
                    WHEN tr.player_steam_id = COALESCE(NEW.captain_steam_id, t.captain_steam_id) THEN 0
                    ELSE 1
                END,
                CASE tr.status
                    WHEN 'Starter' THEN 1
                    WHEN 'Substitute' THEN 2
                    WHEN 'Benched' THEN 3
                    ELSE 4
                END
            LIMIT max_players_per_lineup
        LOOP
            INSERT INTO tournament_team_roster (
                tournament_team_id,
                player_steam_id,
                tournament_id
            )
            VALUES (
                NEW.id,
                player_steam_id,
                NEW.tournament_id
            );
        END LOOP;

        -- Keep the captain on the roster, but tolerate a captain already
        -- rostered on another team in this tournament (shared A/B members):
        -- add them only when they are free, never raise.
        IF NEW.captain_steam_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM tournament_team_roster ttr
                WHERE ttr.tournament_team_id = NEW.id
                  AND ttr.player_steam_id = NEW.captain_steam_id
            )
            AND NOT EXISTS (
                SELECT 1
                FROM tournament_team_roster ttr
                WHERE ttr.tournament_id = NEW.tournament_id
                  AND ttr.player_steam_id = NEW.captain_steam_id
            ) THEN
            INSERT INTO tournament_team_roster (
                tournament_team_id,
                player_steam_id,
                tournament_id
            )
            VALUES (
                NEW.id,
                NEW.captain_steam_id,
                NEW.tournament_id
            );
        END IF;

    END IF;

    RETURN NEW;
END;
$$;

-- Deferred to COMMIT so it fires after Hasura's nested insert has written the
-- client-supplied roster in its own statement; otherwise the auto-fill above
-- runs first, and the client roster then collides on tournament_roster_pkey.
DROP TRIGGER IF EXISTS tai_tournament_team ON public.tournament_teams;
CREATE CONSTRAINT TRIGGER tai_tournament_team
    AFTER INSERT ON public.tournament_teams
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.tai_tournament_team();

CREATE OR REPLACE FUNCTION public.tbu_tournament_team()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.captain_steam_id IS NOT NULL
        AND NEW.captain_steam_id IS DISTINCT FROM OLD.captain_steam_id
        AND NOT EXISTS (
            SELECT 1
            FROM tournament_team_roster ttr
            WHERE ttr.tournament_team_id = NEW.id
              AND ttr.player_steam_id = NEW.captain_steam_id
        ) THEN
        RAISE EXCEPTION 'Tournament captain must be part of the tournament team roster' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_tournament_team ON public.tournament_teams;
CREATE TRIGGER tbu_tournament_team BEFORE UPDATE ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tbu_tournament_team();