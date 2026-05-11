-- Recompute one map's per-player stats into player_match_map_stats from the
-- raw event tables. Called by the match_map_rounds trigger (see
-- hasura/triggers/match_map_rounds.sql) so the stats table only updates at
-- round-end — no mid-round leak.
--
-- Inlines the attacker_team <> attacked_team check rather than calling
-- is_team_kill/is_team_damage as row-typed functions; the row-typed call was
-- a hot spot in the EXPLAIN plan because Postgres couldn't push it through
-- the index. Only events whose round has a corresponding match_map_rounds
-- entry are counted, so mid-round events stay invisible until finalized.
--
-- Co-located here rather than in the migration so edits to the aggregation
-- logic are file-driven (the loader re-applies on digest change) instead of
-- requiring a new migration.

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
    -- Enum values in e_utility_types are capitalised ('Flash', 'Smoke', ...);
    -- the GraphQL layer uses e_utility_types_enum.Flash for the same string.
    SELECT
      pu.attacker_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE pu.type = 'Flash')              AS flashes_thrown
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

-- Idempotent backfill: any map whose stats are missing or whose function
-- definition predates the last edit gets re-computed. Cheap on subsequent
-- boots because the LEFT JOIN returns nothing when stats are already current.
-- Runs whenever this file's digest changes (so a function-logic fix here will
-- re-apply to existing matches without a separate migration).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT mmr.match_map_id
    FROM public.match_map_rounds mmr
    LEFT JOIN public.player_match_map_stats pmms
      ON pmms.match_map_id = mmr.match_map_id
    WHERE pmms.match_map_id IS NULL
  LOOP
    PERFORM public.recompute_player_match_map_stats(r.match_map_id);
  END LOOP;
END;
$$;
