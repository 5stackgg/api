WITH duplicates AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (
      PARTITION BY match_id, region 
      ORDER BY created_at ASC, id ASC
    ) as row_num
  FROM match_region_veto_picks
)
DELETE FROM match_region_veto_picks 
WHERE id IN (
  SELECT id 
  FROM duplicates 
  WHERE row_num > 1
);

alter table "public"."match_region_veto_picks" add constraint "match_region_veto_picks_match_id_region_key" unique ("match_id", "region");
