CREATE OR REPLACE FUNCTION public.tai_player_kills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _season_id UUID;
BEGIN
    INSERT INTO player_kills_by_weapon (player_steam_id, "with", kill_count)
    VALUES (NEW.attacker_steam_id, NEW."with", 1)
    ON CONFLICT (player_steam_id, "with")
    DO UPDATE
      SET kill_count = player_kills_by_weapon.kill_count + 1;


    -- attacker: kills + headshots
    INSERT INTO player_stats (player_steam_id, kills, headshots)
    VALUES (
        NEW.attacker_steam_id,
        1,
        CASE WHEN NEW.headshot THEN 1 ELSE 0 END
    )
    ON CONFLICT (player_steam_id)
    DO UPDATE SET
        kills = player_stats.kills + 1,
        headshots = player_stats.headshots + CASE WHEN NEW.headshot THEN 1 ELSE 0 END,
        headshot_percentage =
        (player_stats.headshots + CASE WHEN NEW.headshot THEN 1 ELSE 0 END)::float
        / (player_stats.kills + 1);

    -- victim: deaths
    INSERT INTO player_stats (player_steam_id, deaths)
    VALUES (NEW.attacked_steam_id, 1)
    ON CONFLICT (player_steam_id)
    DO UPDATE SET
        deaths = player_stats.deaths + 1;

    -- Season stats: attacker kills + headshots
    _season_id := get_active_season();
    IF _season_id IS NOT NULL THEN
        INSERT INTO player_season_stats (player_steam_id, season_id, kills, headshots)
        VALUES (
            NEW.attacker_steam_id,
            _season_id,
            1,
            CASE WHEN NEW.headshot THEN 1 ELSE 0 END
        )
        ON CONFLICT (player_steam_id, season_id)
        DO UPDATE SET
            kills = player_season_stats.kills + 1,
            headshots = player_season_stats.headshots + CASE WHEN NEW.headshot THEN 1 ELSE 0 END,
            headshot_percentage =
            (player_season_stats.headshots + CASE WHEN NEW.headshot THEN 1 ELSE 0 END)::float
            / (player_season_stats.kills + 1);

        -- Season stats: victim deaths
        INSERT INTO player_season_stats (player_steam_id, season_id, deaths)
        VALUES (NEW.attacked_steam_id, _season_id, 1)
        ON CONFLICT (player_steam_id, season_id)
        DO UPDATE SET
            deaths = player_season_stats.deaths + 1;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_kills ON public.player_kills;
CREATE TRIGGER tai_player_kills AFTER INSERT ON public.player_kills FOR EACH ROW EXECUTE FUNCTION public.tai_player_kills();
