CREATE OR REPLACE FUNCTION public.has_backup_file(match_map_rounds match_map_rounds)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    has_backup boolean;
BEGIN
   IF(match_map_rounds.backup_file IS NOT NULL AND match_map_rounds.backup_file != '') THEN
    RETURN TRUE;
   END IF;

   RETURN FALSE;
END;
$function$
