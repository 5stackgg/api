WITH duplicates AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY draft_game_id, picked_steam_id
      ORDER BY created_at ASC, id ASC
    ) AS row_num
  FROM draft_game_picks
)
DELETE FROM draft_game_picks
WHERE id IN (
  SELECT id FROM duplicates WHERE row_num > 1
);

alter table "public"."draft_game_picks"
  add constraint "draft_game_picks_draft_game_id_picked_steam_id_key"
  unique ("draft_game_id", "picked_steam_id");
