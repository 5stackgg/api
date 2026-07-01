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

    -- Season stats: attributed to the season the match belongs to (falls back to the
    -- active season for still-live matches). Deterministic per match so the delete
    -- trigger can decrement the same season on reparse.
    IF seasons_enabled() THEN
        SELECT season_for_timestamp(COALESCE(m.ended_at, now()))
        INTO _season_id
        FROM matches m WHERE m.id = NEW.match_id;

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
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_kills ON public.player_kills;
CREATE TRIGGER tai_player_kills AFTER INSERT ON public.player_kills FOR EACH ROW EXECUTE FUNCTION public.tai_player_kills();

CREATE OR REPLACE FUNCTION public.tad_player_kills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _season_id UUID;
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

    -- Season stats: decrement the same season the insert credited so reparse
    -- (delete + re-insert of player_kills) stays balanced.
    IF seasons_enabled() THEN
        SELECT season_for_timestamp(COALESCE(m.ended_at, now()))
        INTO _season_id
        FROM matches m WHERE m.id = OLD.match_id;

        IF _season_id IS NOT NULL THEN
            UPDATE player_season_stats
               SET kills = GREATEST(kills - 1, 0),
                   headshots = GREATEST(headshots - CASE WHEN OLD.headshot THEN 1 ELSE 0 END, 0),
                   headshot_percentage = CASE
                     WHEN GREATEST(kills - 1, 0) = 0 THEN 0
                     ELSE GREATEST(headshots - CASE WHEN OLD.headshot THEN 1 ELSE 0 END, 0)::float
                          / GREATEST(kills - 1, 0)
                   END
             WHERE player_steam_id = OLD.attacker_steam_id AND season_id = _season_id;

            UPDATE player_season_stats
               SET deaths = GREATEST(deaths - 1, 0)
             WHERE player_steam_id = OLD.attacked_steam_id AND season_id = _season_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_player_kills ON public.player_kills;
CREATE TRIGGER tad_player_kills AFTER DELETE ON public.player_kills FOR EACH ROW EXECUTE FUNCTION public.tad_player_kills();
