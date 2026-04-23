CREATE OR REPLACE FUNCTION public.tbi_tournament_team()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
DECLARE
    tournament tournaments;
    _team_captain_steam_id bigint;
    _session_steam_id bigint;
BEGIN
    SELECT * INTO tournament
    FROM tournaments
    WHERE id = NEW.tournament_id;

    _session_steam_id = nullif(current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id', '')::bigint;

    IF NEW.team_id IS NOT NULL THEN
       SELECT owner_steam_id, captain_steam_id
       INTO NEW.owner_steam_id, _team_captain_steam_id
       FROM teams
       WHERE id = NEW.team_id;

       IF NEW.captain_steam_id IS NULL THEN
           NEW.captain_steam_id = COALESCE(_session_steam_id, _team_captain_steam_id, NEW.owner_steam_id);
       END IF;
    ELSIF NEW.captain_steam_id IS NULL THEN
       NEW.captain_steam_id = COALESCE(NEW.owner_steam_id, _session_steam_id);
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
    tournament_status text;
BEGIN
    SELECT status
    INTO tournament_status
    FROM tournaments
    WHERE id = OLD.tournament_id;

    -- If tournament doesn't exist (cascade delete), allow the team removal
    IF tournament_status IS NOT NULL AND tournament_status IN ('Cancelled', 'CancelledMinTeams', 'Finished') THEN
        RAISE EXCEPTION 'Cannot leave an active tournament' USING ERRCODE = '22000';
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
    IF NEW.team_id IS NOT NULL THEN

        SELECT tournament_max_players_per_lineup(t)
        INTO max_players_per_lineup
        FROM tournaments t
        WHERE t.id = NEW.tournament_id;

        FOR player_steam_id IN
            SELECT tr.player_steam_id
            FROM team_roster tr
            LEFT JOIN tournament_team_roster ttr
                ON ttr.player_steam_id = tr.player_steam_id
               AND ttr.tournament_id = NEW.tournament_id
            WHERE tr.team_id = NEW.team_id
              AND ttr.player_steam_id IS NULL
            ORDER BY
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

        IF NEW.captain_steam_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM tournament_team_roster ttr
                WHERE ttr.tournament_team_id = NEW.id
                  AND ttr.player_steam_id = NEW.captain_steam_id
            ) THEN
            INSERT INTO tournament_team_roster (
                tournament_team_id,
                player_steam_id,
                tournament_id
            )
            SELECT
                NEW.id,
                NEW.captain_steam_id,
                NEW.tournament_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM tournament_team_roster ttr
                WHERE ttr.tournament_id = NEW.tournament_id
                  AND ttr.player_steam_id = NEW.captain_steam_id
            );

            IF NOT EXISTS (
                SELECT 1
                FROM tournament_team_roster ttr
                WHERE ttr.tournament_team_id = NEW.id
                  AND ttr.player_steam_id = NEW.captain_steam_id
            ) THEN
                RAISE EXCEPTION 'Tournament captain must be part of the tournament team roster' USING ERRCODE = '22000';
            END IF;
        END IF;

    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournament_team ON public.tournament_teams;
CREATE TRIGGER tai_tournament_team AFTER INSERT ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tai_tournament_team();

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