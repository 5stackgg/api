CREATE OR REPLACE FUNCTION public.tbi_tournament_team()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
DECLARE
    tournament tournaments;
BEGIN
    SELECT * INTO tournament
    FROM tournaments
    WHERE id = NEW.tournament_id;

    IF NEW.team_id IS NOT NULL THEN
       select owner_steam_id into NEW.owner_steam_id from teams where id = NEW.team_id;
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
    WHERE id = NEW.tournament_id;

    IF tournament_status = 'Cancelled' OR tournament_status = 'CancelledMinTeams' OR tournament_status = 'Finished' THEN
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

    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournament_team ON public.tournament_teams;
CREATE TRIGGER tai_tournament_team AFTER INSERT ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tai_tournament_team();