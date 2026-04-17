CREATE OR REPLACE FUNCTION public.tai_player_assists()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO player_stats (player_steam_id, assists)
    VALUES (
        NEW.attacker_steam_id,
        1
    )
    ON CONFLICT (player_steam_id)
    DO UPDATE SET
        assists = player_stats.assists + 1;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_assists ON public.player_assists;
CREATE TRIGGER tai_player_assists AFTER INSERT ON public.player_assists FOR EACH ROW EXECUTE FUNCTION public.tai_player_assists();

CREATE OR REPLACE FUNCTION public.tad_player_assists()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE player_stats
       SET assists = GREATEST(assists - 1, 0)
     WHERE player_steam_id = OLD.attacker_steam_id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_player_assists ON public.player_assists;
CREATE TRIGGER tad_player_assists AFTER DELETE ON public.player_assists FOR EACH ROW EXECUTE FUNCTION public.tad_player_assists();