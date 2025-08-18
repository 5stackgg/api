CREATE OR REPLACE FUNCTION public.check_team_eligibility(roster tournament_team_roster) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    roster_count INT;
    tournament_type TEXT;
    min_players INT;
    max_players INT;
    tournament public.tournaments;
BEGIN
    SELECT COUNT(*) INTO roster_count
        FROM tournament_team_roster ttr
        WHERE ttr.tournament_team_id = roster.tournament_team_id;

    SELECT * INTO tournament FROM tournaments WHERE id = roster.tournament_id LIMIT 1;

    IF(tournament IS NULL) THEN
        RETURN;
    END IF;

    max_players := tournament_max_players_per_lineup(tournament);

    IF roster_count > max_players THEN
         RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Roster has too many players';
    END IF;

    min_players := tournament_min_players_per_lineup(tournament);

    IF roster_count < min_players THEN
        UPDATE tournament_teams
            SET eligible_at = NULL
            WHERE id = roster.tournament_team_id;
        RETURN;
    END IF;

    UPDATE tournament_teams
        SET eligible_at = NOW()
        WHERE id = roster.tournament_team_id;
END;
$$;