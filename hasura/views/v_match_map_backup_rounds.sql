CREATE OR REPLACE VIEW public.v_match_map_backup_rounds AS
SELECT
    r.match_map_id,
    r.round,
    (r.backup_file IS NOT NULL AND r.backup_file <> '') AS has_backup_file
FROM public.match_map_rounds r
WHERE r.round > 0
  AND r.deleted_at IS NULL;
