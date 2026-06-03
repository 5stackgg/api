-- One-time backfill of existing weapon names to their canonical form. The
-- permanent canonical_weapon() lives in hasura/functions; migrations run before
-- functions, so this uses a session-local copy.
CREATE FUNCTION pg_temp.canonical_weapon(_w text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _w IS NULL THEN NULL
    WHEN lower(_w) LIKE '%knife%' OR lower(_w) = 'bayonet' THEN 'knife'
    ELSE (
      SELECT CASE k
        WHEN 'ak47'            THEN 'ak47'
        WHEN 'm4a1'            THEN 'm4a1'
        WHEN 'm4a4'            THEN 'm4a1'
        WHEN 'm4a1silencer'    THEN 'm4a1_silencer'
        WHEN 'm4a1s'           THEN 'm4a1_silencer'
        WHEN 'famas'           THEN 'famas'
        WHEN 'galil'           THEN 'galilar'
        WHEN 'galilar'         THEN 'galilar'
        WHEN 'aug'             THEN 'aug'
        WHEN 'sg556'           THEN 'sg556'
        WHEN 'sg553'           THEN 'sg556'
        WHEN 'awp'             THEN 'awp'
        WHEN 'ssg08'           THEN 'ssg08'
        WHEN 'scar20'          THEN 'scar20'
        WHEN 'g3sg1'           THEN 'g3sg1'
        WHEN 'glock'           THEN 'glock'
        WHEN 'glock18'         THEN 'glock'
        WHEN 'usp'             THEN 'usp_silencer'
        WHEN 'usps'            THEN 'usp_silencer'
        WHEN 'uspsilencer'     THEN 'usp_silencer'
        WHEN 'p2000'           THEN 'hkp2000'
        WHEN 'hkp2000'         THEN 'hkp2000'
        WHEN 'p250'            THEN 'p250'
        WHEN 'deagle'          THEN 'deagle'
        WHEN 'deserteagle'     THEN 'deagle'
        WHEN 'elite'           THEN 'elite'
        WHEN 'dualberettas'    THEN 'elite'
        WHEN 'fiveseven'       THEN 'fiveseven'
        WHEN 'cz75a'           THEN 'cz75a'
        WHEN 'cz75auto'        THEN 'cz75a'
        WHEN 'tec9'            THEN 'tec9'
        WHEN 'revolver'        THEN 'revolver'
        WHEN 'r8revolver'      THEN 'revolver'
        WHEN 'mac10'           THEN 'mac10'
        WHEN 'mp9'             THEN 'mp9'
        WHEN 'mp7'             THEN 'mp7'
        WHEN 'mp5sd'           THEN 'mp5sd'
        WHEN 'mp5'             THEN 'mp5sd'
        WHEN 'ump45'           THEN 'ump45'
        WHEN 'ump'             THEN 'ump45'
        WHEN 'p90'             THEN 'p90'
        WHEN 'bizon'           THEN 'bizon'
        WHEN 'ppbizon'         THEN 'bizon'
        WHEN 'nova'            THEN 'nova'
        WHEN 'xm1014'          THEN 'xm1014'
        WHEN 'sawedoff'        THEN 'sawedoff'
        WHEN 'mag7'            THEN 'mag7'
        WHEN 'swag7'           THEN 'mag7'
        WHEN 'm249'            THEN 'm249'
        WHEN 'negev'           THEN 'negev'
        WHEN 'taser'           THEN 'taser'
        WHEN 'zeus'            THEN 'taser'
        WHEN 'zeusx27'         THEN 'taser'
        WHEN 'c4'              THEN 'c4'
        WHEN 'bomb'            THEN 'c4'
        WHEN 'hegrenade'       THEN 'hegrenade'
        WHEN 'molotov'         THEN 'molotov'
        WHEN 'inferno'         THEN 'inferno'
        WHEN 'incgrenade'      THEN 'inferno'
        WHEN 'incendiarygrenade' THEN 'inferno'
        WHEN 'smokegrenade'    THEN 'smokegrenade'
        WHEN 'flashbang'       THEN 'flashbang'
        WHEN 'decoy'           THEN 'decoy'
        WHEN 'decoygrenade'    THEN 'decoy'
        ELSE k
      END
      FROM (
        SELECT regexp_replace(lower(replace(_w, 'weapon_', '')), '[^a-z0-9]', '', 'g') AS k
      ) t
    )
  END;
$$;

UPDATE public.player_kills
   SET "with" = pg_temp.canonical_weapon("with")
 WHERE "with" IS NOT NULL
   AND "with" IS DISTINCT FROM pg_temp.canonical_weapon("with");

UPDATE public.player_damages
   SET "with" = pg_temp.canonical_weapon("with")
 WHERE "with" IS NOT NULL
   AND "with" IS DISTINCT FROM pg_temp.canonical_weapon("with");

TRUNCATE public.player_kills_by_weapon;
INSERT INTO public.player_kills_by_weapon (player_steam_id, "with", kill_count)
SELECT attacker_steam_id, "with", COUNT(*)
FROM public.player_kills
WHERE attacker_steam_id IS NOT NULL
  AND "with" IS NOT NULL
GROUP BY attacker_steam_id, "with";
