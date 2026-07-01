CREATE OR REPLACE FUNCTION public.tai_player_assists()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _season_id UUID;
BEGIN
    INSERT INTO player_stats (player_steam_id, assists)
    VALUES (
        NEW.attacker_steam_id,
        1
    )
    ON CONFLICT (player_steam_id)
    DO UPDATE SET
        assists = player_stats.assists + 1;

    -- Season stats: assists, attributed to the match's season (see player_kills.sql)
    IF seasons_enabled() THEN
        SELECT season_for_timestamp(COALESCE(m.ended_at, now()))
        INTO _season_id
        FROM matches m WHERE m.id = NEW.match_id;

        IF _season_id IS NOT NULL THEN
            INSERT INTO player_season_stats (player_steam_id, season_id, assists)
            VALUES (NEW.attacker_steam_id, _season_id, 1)
            ON CONFLICT (player_steam_id, season_id)
            DO UPDATE SET
                assists = player_season_stats.assists + 1;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_assists ON public.player_assists;
CREATE TRIGGER tai_player_assists AFTER INSERT ON public.player_assists FOR EACH ROW EXECUTE FUNCTION public.tai_player_assists();
CREATE OR REPLACE FUNCTION public.tad_player_assists()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _season_id UUID;
BEGIN
    UPDATE player_stats
       SET assists = GREATEST(assists - 1, 0)
     WHERE player_steam_id = OLD.attacker_steam_id;

    IF seasons_enabled() THEN
        SELECT season_for_timestamp(COALESCE(m.ended_at, now()))
        INTO _season_id
        FROM matches m WHERE m.id = OLD.match_id;

        IF _season_id IS NOT NULL THEN
            UPDATE player_season_stats
               SET assists = GREATEST(assists - 1, 0)
             WHERE player_steam_id = OLD.attacker_steam_id AND season_id = _season_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_player_assists ON public.player_assists;
CREATE TRIGGER tad_player_assists AFTER DELETE ON public.player_assists FOR EACH ROW EXECUTE FUNCTION public.tad_player_assists();
