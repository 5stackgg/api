-- Restorable rounds for the admin "restore round" UI. Exists so we can lock
-- down match_map_rounds (which carries economy/money) to finished maps without
-- breaking mid-match round restores: this view exposes ONLY the round number +
-- backup availability (neither is sensitive — round numbers are just the score
-- progression), so it can stay readable live while match_map_rounds itself is
-- gated. has_backup_file mirrors the computed field on match_map_rounds.
CREATE OR REPLACE VIEW public.v_match_map_backup_rounds AS
SELECT
    r.match_map_id,
    r.round,
    (r.backup_file IS NOT NULL AND r.backup_file <> '') AS has_backup_file
FROM public.match_map_rounds r
WHERE r.round > 0
  AND r.backup_file IS NOT NULL
  AND r.backup_file <> '';
