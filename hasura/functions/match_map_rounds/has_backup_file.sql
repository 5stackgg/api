CREATE OR REPLACE FUNCTION public.has_backup_file(match_map_rounds match_map_rounds)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT match_map_rounds.backup_file IS NOT NULL
       AND match_map_rounds.backup_file != '';
$$;
