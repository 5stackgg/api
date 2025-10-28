WITH duplicates AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (
      PARTITION BY match_id, map_id 
      ORDER BY created_at ASC, id ASC
    ) as row_num
  FROM match_map_veto_picks
)
DELETE FROM match_map_veto_picks 
WHERE id IN (
  SELECT id 
  FROM duplicates 
  WHERE row_num > 1
);

alter table "public"."match_map_veto_picks" add constraint "match_map_veto_picks_match_id_map_id_key" unique ("match_id", "map_id");
