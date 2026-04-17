CREATE OR REPLACE FUNCTION public.tai_player_kills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_kills ON public.player_kills;
CREATE TRIGGER tai_player_kills AFTER INSERT ON public.player_kills FOR EACH ROW EXECUTE FUNCTION public.tai_player_kills();

CREATE OR REPLACE FUNCTION public.tad_player_kills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE player_kills_by_weapon
       SET kill_count = kill_count - 1
     WHERE player_steam_id = OLD.attacker_steam_id AND "with" = OLD."with";

    DELETE FROM player_kills_by_weapon
     WHERE player_steam_id = OLD.attacker_steam_id
       AND "with" = OLD."with"
       AND kill_count <= 0;

    -- attacker: kills + headshots
    UPDATE player_stats
       SET kills = GREATEST(kills - 1, 0),
           headshots = GREATEST(headshots - CASE WHEN OLD.headshot THEN 1 ELSE 0 END, 0),
           headshot_percentage = CASE
             WHEN GREATEST(kills - 1, 0) = 0 THEN 0
             ELSE GREATEST(headshots - CASE WHEN OLD.headshot THEN 1 ELSE 0 END, 0)::float
                  / GREATEST(kills - 1, 0)
           END
     WHERE player_steam_id = OLD.attacker_steam_id;

    -- victim: deaths
    UPDATE player_stats
       SET deaths = GREATEST(deaths - 1, 0)
     WHERE player_steam_id = OLD.attacked_steam_id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_player_kills ON public.player_kills;
CREATE TRIGGER tad_player_kills AFTER DELETE ON public.player_kills FOR EACH ROW EXECUTE FUNCTION public.tad_player_kills();