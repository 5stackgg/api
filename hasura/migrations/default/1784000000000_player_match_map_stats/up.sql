-- Denormalized per-player per-map stats. One row per (steam_id, match_map_id).
-- Maintained by an AFTER INSERT/UPDATE/DELETE trigger on match_map_rounds, so
-- the table only updates at round-end (no mid-round leak) and is recomputed
-- atomically when a round is restored.
--
-- Reads in the GraphQL layer go from ~13 hypertable aggregates per player to
-- a single indexed row lookup — see the matching player_match_stats_v view
-- below for the all-maps rollup.

CREATE TABLE IF NOT EXISTS public.player_match_map_stats (
  steam_id              bigint  NOT NULL,
  match_map_id          uuid    NOT NULL,
  match_id              uuid    NOT NULL,

  -- kills (attacker, non-team-kill unless noted)
  kills                 integer NOT NULL DEFAULT 0,
  hs_kills              integer NOT NULL DEFAULT 0,
  knife_kills           integer NOT NULL DEFAULT 0,
  zeus_kills            integer NOT NULL DEFAULT 0,

  -- assists
  assists               integer NOT NULL DEFAULT 0,
  flash_assists         integer NOT NULL DEFAULT 0,

  -- deaths
  deaths                integer NOT NULL DEFAULT 0,

  -- damage dealt (attacker)
  damage                integer NOT NULL DEFAULT 0,
  team_damage           integer NOT NULL DEFAULT 0,
  he_damage             integer NOT NULL DEFAULT 0,
  molotov_damage        integer NOT NULL DEFAULT 0,

  -- flashes (attacker side)
  flashes_thrown        integer NOT NULL DEFAULT 0,
  enemies_flashed       integer NOT NULL DEFAULT 0,
  team_flashed          integer NOT NULL DEFAULT 0,
  flash_duration_sum    numeric NOT NULL DEFAULT 0,
  flash_duration_count  integer NOT NULL DEFAULT 0,

  -- multi-kill round counts (mirror v_player_multi_kills.kills > 1, suicide-excluded)
  two_kill_rounds       integer NOT NULL DEFAULT 0,
  three_kill_rounds     integer NOT NULL DEFAULT 0,
  four_kill_rounds      integer NOT NULL DEFAULT 0,
  five_kill_rounds      integer NOT NULL DEFAULT 0,

  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT player_match_map_stats_pkey
    PRIMARY KEY (steam_id, match_map_id),
  CONSTRAINT player_match_map_stats_steam_id_fkey
    FOREIGN KEY (steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT player_match_map_stats_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_match_map_stats_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_match_map_stats_match_id
  ON public.player_match_map_stats (match_id);

CREATE INDEX IF NOT EXISTS idx_player_match_map_stats_match_id_steam_id
  ON public.player_match_map_stats (match_id, steam_id);

-- All-maps rollup: SUM per (steam_id, match_id). One row per player per match,
-- regardless of how many maps were played. Powers the "no specific map selected"
-- Overview tab.
CREATE OR REPLACE VIEW public.player_match_stats_v AS
SELECT
  s.steam_id,
  s.match_id,
  SUM(s.kills)::integer                AS kills,
  SUM(s.hs_kills)::integer             AS hs_kills,
  SUM(s.knife_kills)::integer          AS knife_kills,
  SUM(s.zeus_kills)::integer           AS zeus_kills,
  SUM(s.assists)::integer              AS assists,
  SUM(s.flash_assists)::integer        AS flash_assists,
  SUM(s.deaths)::integer               AS deaths,
  SUM(s.damage)::integer               AS damage,
  SUM(s.team_damage)::integer          AS team_damage,
  SUM(s.he_damage)::integer            AS he_damage,
  SUM(s.molotov_damage)::integer       AS molotov_damage,
  SUM(s.flashes_thrown)::integer       AS flashes_thrown,
  SUM(s.enemies_flashed)::integer      AS enemies_flashed,
  SUM(s.team_flashed)::integer         AS team_flashed,
  CASE WHEN SUM(s.flash_duration_count) > 0
       THEN (SUM(s.flash_duration_sum) / SUM(s.flash_duration_count))::numeric
       ELSE 0::numeric
  END                                  AS avg_flash_duration,
  SUM(s.two_kill_rounds)::integer      AS two_kill_rounds,
  SUM(s.three_kill_rounds)::integer    AS three_kill_rounds,
  SUM(s.four_kill_rounds)::integer     AS four_kill_rounds,
  SUM(s.five_kill_rounds)::integer     AS five_kill_rounds
FROM public.player_match_map_stats s
GROUP BY s.steam_id, s.match_id;

-- Recompute one map's stats from raw events. Inlines the attacker_team =
-- attacked_team check (cheaper than calling is_team_kill/is_team_damage as
-- row-typed functions — those were a hot spot in EXPLAIN). Only events whose
-- round has a corresponding match_map_rounds entry count, so mid-round events
-- are invisible until the round is finalized.
CREATE OR REPLACE FUNCTION public.recompute_player_match_map_stats(p_match_map_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_match_id uuid;
BEGIN
  SELECT match_id INTO v_match_id
  FROM public.match_maps
  WHERE id = p_match_map_id;

  IF NOT FOUND THEN
    -- Map gone (e.g. cascade delete): nothing to recompute.
    DELETE FROM public.player_match_map_stats WHERE match_map_id = p_match_map_id;
    RETURN;
  END IF;

  -- Wipe-and-rewrite is simpler than diffing event-by-event and is fine because
  -- it only runs at round boundaries (handful of times per map).
  DELETE FROM public.player_match_map_stats WHERE match_map_id = p_match_map_id;

  WITH finalized_rounds AS (
    SELECT round
    FROM public.match_map_rounds
    WHERE match_map_id = p_match_map_id
  ),
  -- Every steam_id that appears in any event for this map's finalized rounds.
  -- This is the universe of rows we'll emit; missing aggregates default to 0.
  player_set AS (
    SELECT DISTINCT steam_id FROM (
      SELECT attacker_steam_id AS steam_id
        FROM public.player_kills pk
        WHERE pk.match_map_id = p_match_map_id
          AND pk.attacker_steam_id IS NOT NULL
          AND pk.round IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT pk.attacked_steam_id
        FROM public.player_kills pk
        WHERE pk.match_map_id = p_match_map_id
          AND pk.round IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT pd.attacker_steam_id
        FROM public.player_damages pd
        WHERE pd.match_map_id = p_match_map_id
          AND pd.attacker_steam_id IS NOT NULL
          AND pd.round::integer IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT pa.attacker_steam_id
        FROM public.player_assists pa
        WHERE pa.match_map_id = p_match_map_id
          AND pa.round IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT pf.attacker_steam_id
        FROM public.player_flashes pf
        WHERE pf.match_map_id = p_match_map_id
          AND pf.round IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT pu.attacker_steam_id
        FROM public.player_utility pu
        WHERE pu.match_map_id = p_match_map_id
          AND pu.round IN (SELECT round FROM finalized_rounds)
    ) ids
    WHERE steam_id IS NOT NULL
  ),
  kills_agg AS (
    SELECT
      pk.attacker_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE pk.attacker_team <> pk.attacked_team)                                AS kills,
      COUNT(*) FILTER (WHERE pk.attacker_team <> pk.attacked_team AND pk.headshot)                AS hs_kills,
      COUNT(*) FILTER (WHERE pk.attacker_team <> pk.attacked_team AND pk."with" LIKE 'knife%')    AS knife_kills,
      COUNT(*) FILTER (WHERE pk.attacker_team <> pk.attacked_team AND pk."with" = 'taser')        AS zeus_kills
    FROM public.player_kills pk
    WHERE pk.match_map_id = p_match_map_id
      AND pk.attacker_steam_id IS NOT NULL
      AND pk.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pk.attacker_steam_id
  ),
  deaths_agg AS (
    SELECT pk.attacked_steam_id AS steam_id, COUNT(*) AS deaths
    FROM public.player_kills pk
    WHERE pk.match_map_id = p_match_map_id
      AND pk.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pk.attacked_steam_id
  ),
  assists_agg AS (
    SELECT
      pa.attacker_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE pa.attacker_team <> pa.attacked_team)                        AS assists,
      COUNT(*) FILTER (WHERE pa.attacker_team <> pa.attacked_team AND pa.flash)           AS flash_assists
    FROM public.player_assists pa
    WHERE pa.match_map_id = p_match_map_id
      AND pa.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pa.attacker_steam_id
  ),
  damage_agg AS (
    SELECT
      pd.attacker_steam_id AS steam_id,
      COALESCE(SUM(pd.damage) FILTER (WHERE pd.attacker_team <> pd.attacked_team), 0)::integer                            AS damage,
      COALESCE(SUM(pd.damage) FILTER (WHERE pd.attacker_team =  pd.attacked_team), 0)::integer                            AS team_damage,
      COALESCE(SUM(pd.damage) FILTER (WHERE pd.attacker_team <> pd.attacked_team AND pd."with" = 'hegrenade'), 0)::integer AS he_damage,
      COALESCE(SUM(pd.damage) FILTER (
        WHERE pd.attacker_team <> pd.attacked_team
          AND pd."with" IN ('molotov', 'inferno')
      ), 0)::integer                                                                                                       AS molotov_damage
    FROM public.player_damages pd
    WHERE pd.match_map_id = p_match_map_id
      AND pd.attacker_steam_id IS NOT NULL
      AND pd.round::integer IN (SELECT round FROM finalized_rounds)
    GROUP BY pd.attacker_steam_id
  ),
  flash_agg AS (
    SELECT
      pf.attacker_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE NOT pf.team_flash)              AS enemies_flashed,
      COUNT(*) FILTER (WHERE pf.team_flash)                  AS team_flashed,
      COALESCE(SUM(pf.duration), 0)                          AS flash_duration_sum,
      COUNT(*)                                               AS flash_duration_count
    FROM public.player_flashes pf
    WHERE pf.match_map_id = p_match_map_id
      AND pf.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pf.attacker_steam_id
  ),
  utility_agg AS (
    SELECT
      pu.attacker_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE pu.type = 'flash')              AS flashes_thrown
    FROM public.player_utility pu
    WHERE pu.match_map_id = p_match_map_id
      AND pu.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pu.attacker_steam_id
  ),
  -- multi-kills per round (suicide-excluded, matches v_player_multi_kills logic
  -- but scoped to this map and finalized rounds only)
  multi_k_rounds AS (
    SELECT
      pk.attacker_steam_id AS steam_id,
      pk.round,
      COUNT(*) AS kc
    FROM public.player_kills pk
    WHERE pk.match_map_id = p_match_map_id
      AND pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id <> pk.attacked_steam_id
      AND pk.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pk.attacker_steam_id, pk.round
    HAVING COUNT(*) > 1
  ),
  multi_k_agg AS (
    SELECT
      steam_id,
      COUNT(*) FILTER (WHERE kc = 2) AS two_kill_rounds,
      COUNT(*) FILTER (WHERE kc = 3) AS three_kill_rounds,
      COUNT(*) FILTER (WHERE kc = 4) AS four_kill_rounds,
      COUNT(*) FILTER (WHERE kc >= 5) AS five_kill_rounds
    FROM multi_k_rounds
    GROUP BY steam_id
  )
  INSERT INTO public.player_match_map_stats (
    steam_id, match_map_id, match_id,
    kills, hs_kills, knife_kills, zeus_kills,
    assists, flash_assists,
    deaths,
    damage, team_damage, he_damage, molotov_damage,
    flashes_thrown, enemies_flashed, team_flashed,
    flash_duration_sum, flash_duration_count,
    two_kill_rounds, three_kill_rounds, four_kill_rounds, five_kill_rounds
  )
  SELECT
    ps.steam_id, p_match_map_id, v_match_id,
    COALESCE(ka.kills, 0),       COALESCE(ka.hs_kills, 0),
    COALESCE(ka.knife_kills, 0), COALESCE(ka.zeus_kills, 0),
    COALESCE(aa.assists, 0),     COALESCE(aa.flash_assists, 0),
    COALESCE(da.deaths, 0),
    COALESCE(dmg.damage, 0),         COALESCE(dmg.team_damage, 0),
    COALESCE(dmg.he_damage, 0),      COALESCE(dmg.molotov_damage, 0),
    COALESCE(ua.flashes_thrown, 0),
    COALESCE(fa.enemies_flashed, 0), COALESCE(fa.team_flashed, 0),
    COALESCE(fa.flash_duration_sum, 0), COALESCE(fa.flash_duration_count, 0),
    COALESCE(mka.two_kill_rounds, 0),  COALESCE(mka.three_kill_rounds, 0),
    COALESCE(mka.four_kill_rounds, 0), COALESCE(mka.five_kill_rounds, 0)
  FROM player_set ps
  LEFT JOIN kills_agg    ka  ON ka.steam_id  = ps.steam_id
  LEFT JOIN deaths_agg   da  ON da.steam_id  = ps.steam_id
  LEFT JOIN assists_agg  aa  ON aa.steam_id  = ps.steam_id
  LEFT JOIN damage_agg   dmg ON dmg.steam_id = ps.steam_id
  LEFT JOIN flash_agg    fa  ON fa.steam_id  = ps.steam_id
  LEFT JOIN utility_agg  ua  ON ua.steam_id  = ps.steam_id
  LEFT JOIN multi_k_agg  mka ON mka.steam_id = ps.steam_id;
END;
$$;

-- Trigger: recompute the affected map whenever its round table changes.
-- INSERT: new round finalized. UPDATE: score correction. DELETE: restore_round
-- removed a round; stats need to roll back.
CREATE OR REPLACE FUNCTION public.tai_match_map_rounds_recompute_stats()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM public.recompute_player_match_map_stats(OLD.match_map_id);
    RETURN OLD;
  ELSE
    PERFORM public.recompute_player_match_map_stats(NEW.match_map_id);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_map_rounds_recompute_stats ON public.match_map_rounds;
CREATE TRIGGER tai_match_map_rounds_recompute_stats
  AFTER INSERT OR UPDATE OR DELETE ON public.match_map_rounds
  FOR EACH ROW
  EXECUTE FUNCTION public.tai_match_map_rounds_recompute_stats();

-- Backfill: populate stats for every map that already has finalized rounds.
-- Idempotent — recompute() does DELETE + INSERT for the target map.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT match_map_id
    FROM public.match_map_rounds
  LOOP
    PERFORM public.recompute_player_match_map_stats(r.match_map_id);
  END LOOP;
END;
$$;
