DROP TRIGGER IF EXISTS tbd_match_map_veto_picks ON public.match_map_veto_picks;

WITH duplicates AS (
  SELECT 
    mmvp.id,
    ROW_NUMBER() OVER (
      PARTITION BY mmvp.match_id, mmvp.map_id 
      ORDER BY 
        CASE WHEN EXISTS (
          SELECT 1 FROM match_maps mm 
          JOIN match_map_demos mmd ON mmd.match_map_id = mm.id 
          WHERE mm.match_id = mmvp.match_id AND mm.map_id = mmvp.map_id
        ) THEN 0 ELSE 1 END,
        mmvp.created_at ASC, 
        mmvp.id ASC
    ) as row_num
  FROM match_map_veto_picks mmvp
)
DELETE FROM match_map_veto_picks 
WHERE id IN (
  SELECT id 
  FROM duplicates 
  WHERE row_num > 1
);

CREATE OR REPLACE FUNCTION public.tbd_match_map_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM match_maps WHERE map_id = OLD.map_id AND match_id = OLD.match_id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER tbd_match_map_veto_picks BEFORE DELETE ON public.match_map_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tbd_match_map_veto_picks();

alter table "public"."match_map_veto_picks" add constraint "match_map_veto_picks_match_id_map_id_key" unique ("match_id", "map_id");
