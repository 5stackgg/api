DELETE FROM player_flashes WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY match_map_id, time, attacker_steam_id, attacked_steam_id
                   ORDER BY id
               ) as rn
        FROM player_flashes
    ) t
    WHERE t.rn > 1
);

ALTER TABLE "public"."player_flashes" DROP CONSTRAINT "player_flashes_pkey";

ALTER TABLE "public"."player_flashes"
    ADD CONSTRAINT "player_flashes_pkey" PRIMARY KEY ("match_map_id", "time", "attacker_steam_id", "attacked_steam_id");

alter table "public"."player_flashes" drop column if exists "id" cascade;
