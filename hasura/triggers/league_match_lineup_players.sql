-- Roster-lock enforcement at the lineup level for league matches: only
-- players on the (locked) tournament roster of the lineup's team may appear
-- in a league match lineup, regardless of which join path added them.
-- System inserts from schedule_tournament_match originate from that same
-- roster, so they always pass.

CREATE OR REPLACE FUNCTION public.tbi_league_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament_team_id uuid;
BEGIN
    IF NEW.steam_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Resolve the tournament team this lineup represents, but only for
    -- matches that belong to a league division tournament.
    SELECT CASE
               WHEN m.lineup_1_id = ml.id THEN tb.tournament_team_id_1
               ELSE tb.tournament_team_id_2
           END
    INTO _tournament_team_id
    FROM public.match_lineups ml
    JOIN public.matches m ON m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id
    JOIN public.tournament_brackets tb ON tb.match_id = m.id
    JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
    JOIN public.league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
    WHERE ml.id = NEW.match_lineup_id;

    IF _tournament_team_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.tournament_team_roster ttr
        WHERE ttr.tournament_team_id = _tournament_team_id
          AND ttr.player_steam_id = NEW.steam_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Only rostered players can play league matches';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_league_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbi_league_match_lineup_players
    BEFORE INSERT ON public.match_lineup_players
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_league_match_lineup_players();
