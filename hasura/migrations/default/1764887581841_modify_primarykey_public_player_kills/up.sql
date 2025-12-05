update player_kills set attacker_steam_id = attacked_steam_id where attacker_steam_id is null;

DELETE FROM player_kills
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY match_map_id, time, attacker_steam_id, attacked_steam_id
                   ORDER BY id
               ) as rn
        FROM player_kills
    ) t
    WHERE t.rn > 1
);

alter table player_kills alter column attacker_steam_id set not null;

ALTER TABLE "public"."player_kills" DROP CONSTRAINT "player_kills_pkey";

ALTER TABLE "public"."player_kills"
    ADD CONSTRAINT "player_kills_pkey" PRIMARY KEY ("match_map_id", "time", "attacker_steam_id", "attacked_steam_id");

alter table "public"."player_kills" drop column if exists "id" cascade;
