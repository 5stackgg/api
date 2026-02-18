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

    -- Season stats: assists
    _season_id := get_active_season();
    IF _season_id IS NOT NULL THEN
        INSERT INTO player_season_stats (player_steam_id, season_id, assists)
        VALUES (NEW.attacker_steam_id, _season_id, 1)
        ON CONFLICT (player_steam_id, season_id)
        DO UPDATE SET
            assists = player_season_stats.assists + 1;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_assists ON public.player_assists;
CREATE TRIGGER tai_player_assists AFTER INSERT ON public.player_assists FOR EACH ROW EXECUTE FUNCTION public.tai_player_assists();
