DELETE FROM player_assists
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY match_map_id, round, time, attacker_steam_id, attacked_steam_id
                   ORDER BY id
               ) as rn
        FROM player_assists
    ) t
    WHERE t.rn > 1
);

ALTER TABLE "public"."player_assists" DROP CONSTRAINT "player_assists_pkey";

ALTER TABLE "public"."player_assists"
    ADD CONSTRAINT "player_assists_pkey" PRIMARY KEY ("match_map_id", "attacker_steam_id", "attacked_steam_id", "time");

alter table "public"."player_assists" drop column if exists "id" cascade;
