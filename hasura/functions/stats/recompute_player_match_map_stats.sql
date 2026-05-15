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
    DELETE FROM public.player_match_map_stats WHERE match_map_id = p_match_map_id;
    RETURN;
  END IF;

  DELETE FROM public.player_match_map_stats WHERE match_map_id = p_match_map_id;

  WITH finalized_rounds AS (
    SELECT round
    FROM public.match_map_rounds
    WHERE match_map_id = p_match_map_id
  ),
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
      UNION
      SELECT psf.attacker_steam_id
        FROM public.player_shots_fired psf
        WHERE psf.match_map_id = p_match_map_id
          AND psf.round IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT psp.spotter_steam_id
        FROM public.player_spotted psp
        WHERE psp.match_map_id = p_match_map_id
          AND psp.round IN (SELECT round FROM finalized_rounds)
      UNION
      SELECT pgt.thrower_steam_id
        FROM public.player_grenade_throws pgt
        WHERE pgt.match_map_id = p_match_map_id
          AND pgt.round IN (SELECT round FROM finalized_rounds)
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
      COUNT(*) FILTER (WHERE pu.type = 'Flash')              AS flashes_thrown
    FROM public.player_utility pu
    WHERE pu.match_map_id = p_match_map_id
      AND pu.round IN (SELECT round FROM finalized_rounds)
    GROUP BY pu.attacker_steam_id
  ),
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
  ),
  -- Per-(player, round) team. Sides only flip at halftime, never mid-round,
  -- so collapsing (attacker | attacked) rows by DISTINCT is safe.
  player_round_team AS (
    SELECT DISTINCT match_map_id, round, steam_id, team
    FROM (
      SELECT pk.match_map_id, pk.round,
             pk.attacker_steam_id AS steam_id,
             pk.attacker_team     AS team
      FROM public.player_kills pk
      WHERE pk.match_map_id = p_match_map_id
        AND pk.attacker_steam_id IS NOT NULL
        AND pk.attacker_team IS NOT NULL
        AND pk.round IN (SELECT round FROM finalized_rounds)
      UNION ALL
      SELECT pk.match_map_id, pk.round,
             pk.attacked_steam_id AS steam_id,
             pk.attacked_team     AS team
      FROM public.player_kills pk
      WHERE pk.match_map_id = p_match_map_id
        AND pk.round IN (SELECT round FROM finalized_rounds)
    ) u
    WHERE steam_id IS NOT NULL
  ),
  -- Trade pairs: a victim V was killed by A; a teammate of V then kills A
  -- within 5 seconds. Each row is one (victim death, trader kill) pair.
  -- player_kills.time is timestamptz → use interval arithmetic.
  trade_pairs AS (
    SELECT
      victim.attacker_steam_id  AS killer_of_victim,
      victim.attacked_steam_id  AS victim_steam_id,
      victim.attacked_team      AS victim_team,
      trader.attacker_steam_id  AS trader_steam_id,
      trader.attacker_team      AS trader_team,
      victim.round
    FROM public.player_kills victim
    JOIN public.player_kills trader
      ON trader.match_map_id        = victim.match_map_id
     AND trader.round               = victim.round
     AND trader.attacked_steam_id   = victim.attacker_steam_id
     AND trader.attacker_team       = victim.attacked_team
     AND trader.attacker_steam_id  <> victim.attacked_steam_id
     AND trader.time                > victim.time
     AND trader.time               <= victim.time + interval '5 seconds'
    WHERE victim.match_map_id  = p_match_map_id
      AND victim.attacker_team <> victim.attacked_team
      AND victim.round IN (SELECT round FROM finalized_rounds)
  ),
  trade_kill_agg AS (
    -- Under the 5s-window definition, every trade kill that happened counts
    -- as both an attempt and a success (Leetify exposes them as separate
    -- columns for symmetry; we keep the same shape).
    SELECT
      trader_steam_id AS steam_id,
      COUNT(*)        AS trade_kill_attempts,
      COUNT(*)        AS trade_kill_successes
    FROM trade_pairs
    WHERE trader_steam_id IS NOT NULL
    GROUP BY trader_steam_id
  ),
  trade_kill_opp_agg AS (
    -- For every enemy kill V, every teammate of V who was still alive at
    -- v.time gets one "trade kill opportunity". Alive = no earlier death
    -- this round.
    SELECT tm.steam_id, COUNT(*) AS trade_kill_opportunities
    FROM public.player_kills v
    JOIN player_round_team tm
      ON tm.match_map_id = v.match_map_id
     AND tm.round        = v.round
     AND tm.team         = v.attacked_team
     AND tm.steam_id    <> v.attacked_steam_id
    WHERE v.match_map_id  = p_match_map_id
      AND v.attacker_team <> v.attacked_team
      AND v.round IN (SELECT round FROM finalized_rounds)
      AND NOT EXISTS (
        SELECT 1
        FROM public.player_kills d
        WHERE d.match_map_id      = v.match_map_id
          AND d.round             = v.round
          AND d.attacked_steam_id = tm.steam_id
          AND d.time              < v.time
      )
    GROUP BY tm.steam_id
  ),
  traded_death_agg AS (
    -- A player can only die once per round; DISTINCT round collapses any
    -- (victim, round) pair that had multiple traders.
    SELECT victim_steam_id AS steam_id, COUNT(DISTINCT round) AS traded_death_successes
    FROM trade_pairs
    WHERE victim_steam_id IS NOT NULL
    GROUP BY victim_steam_id
  ),
  traded_death_opp_agg AS (
    SELECT attacked_steam_id AS steam_id, COUNT(*) AS traded_death_opportunities
    FROM public.player_kills
    WHERE match_map_id  = p_match_map_id
      AND attacker_team <> attacked_team
      AND round IN (SELECT round FROM finalized_rounds)
    GROUP BY attacked_steam_id
  ),
  -- Demo-parser-sourced raw events. Live GSI never writes here; rows
  -- show up only after demo ingestion calls back into the recompute.
  shots_agg AS (
    SELECT attacker_steam_id AS steam_id, COUNT(*) AS shots_fired
    FROM public.player_shots_fired
    WHERE match_map_id = p_match_map_id
      AND round IN (SELECT round FROM finalized_rounds)
    GROUP BY attacker_steam_id
  ),
  hits_agg AS (
    SELECT
      pd.attacker_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE pd.attacker_team <> pd.attacked_team)                                       AS hits,
      COUNT(*) FILTER (WHERE pd.attacker_team <> pd.attacked_team AND pd.hitgroup = 'head')              AS headshot_hits
    FROM public.player_damages pd
    WHERE pd.match_map_id = p_match_map_id
      AND pd.attacker_steam_id IS NOT NULL
      AND pd.round::integer IN (SELECT round FROM finalized_rounds)
    GROUP BY pd.attacker_steam_id
  ),
  -- Time-to-damage: per round, take the first damage event by attacker A
  -- (relative to round start), then average across rounds. Rounds where A
  -- dealt no damage are excluded from the count, not counted as zero —
  -- Leetify uses the same definition.
  ttd_per_round AS (
    SELECT
      pd.attacker_steam_id AS steam_id,
      pd.round::integer    AS round,
      MIN(EXTRACT(EPOCH FROM (pd.time - r.time))) AS first_damage_s
    FROM public.player_damages pd
    JOIN public.match_map_rounds r
      ON r.match_map_id = pd.match_map_id
     AND r.round        = pd.round::integer
    WHERE pd.match_map_id = p_match_map_id
      AND pd.attacker_steam_id IS NOT NULL
      AND pd.attacker_team <> pd.attacked_team
      AND pd.round::integer IN (SELECT round FROM finalized_rounds)
    GROUP BY pd.attacker_steam_id, pd.round::integer
  ),
  ttd_agg AS (
    SELECT steam_id,
           COALESCE(SUM(first_damage_s), 0)::numeric AS time_to_damage_sum_s,
           COUNT(*)::integer                         AS time_to_damage_count
    FROM ttd_per_round
    WHERE first_damage_s IS NOT NULL AND first_damage_s >= 0
    GROUP BY steam_id
  ),
  spotted_agg AS (
    SELECT
      ps.spotter_steam_id AS steam_id,
      COUNT(*) AS spotted_count,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM public.player_damages pd
          WHERE pd.match_map_id      = ps.match_map_id
            AND pd.round::integer    = ps.round
            AND pd.attacker_steam_id = ps.spotter_steam_id
            AND pd.attacked_steam_id = ps.spotted_steam_id
            AND pd.attacker_team    <> pd.attacked_team
            -- Demo ticks aren't directly comparable to GSI wall-clock,
            -- so we widen to "anywhere in this same round" for the v1.
            -- A tick-based version comes in once demo ingestion writes
            -- player_damages.tick too.
        )
      ) AS spotted_with_damage_count
    FROM public.player_spotted ps
    WHERE ps.match_map_id = p_match_map_id
      AND ps.round IN (SELECT round FROM finalized_rounds)
    GROUP BY ps.spotter_steam_id
  ),
  throws_agg AS (
    SELECT
      thrower_steam_id AS steam_id,
      COUNT(*) FILTER (WHERE type = 'HE')      AS he_throws,
      COUNT(*) FILTER (WHERE type = 'Molotov') AS molotov_throws,
      COUNT(*) FILTER (WHERE type = 'Smoke')   AS smoke_throws,
      COUNT(*) FILTER (WHERE type = 'Decoy')   AS decoy_throws
    FROM public.player_grenade_throws
    WHERE match_map_id = p_match_map_id
      AND phase = 'thrown'
      AND thrower_steam_id IS NOT NULL
      AND round IN (SELECT round FROM finalized_rounds)
    GROUP BY thrower_steam_id
  ),
  -- Same value for every player in the map; precomputed once.
  rounds_played_const AS (
    SELECT COUNT(*)::integer AS rounds_played FROM finalized_rounds
  )
  INSERT INTO public.player_match_map_stats (
    steam_id, match_map_id, match_id,
    kills, hs_kills, knife_kills, zeus_kills,
    assists, flash_assists,
    deaths,
    damage, team_damage, he_damage, molotov_damage,
    flashes_thrown, enemies_flashed, team_flashed,
    flash_duration_sum, flash_duration_count,
    two_kill_rounds, three_kill_rounds, four_kill_rounds, five_kill_rounds,
    trade_kill_opportunities, trade_kill_attempts, trade_kill_successes,
    traded_death_opportunities, traded_death_successes,
    shots_fired, hits, headshot_hits,
    time_to_damage_sum_s, time_to_damage_count,
    spotted_count, spotted_with_damage_count,
    he_throws, molotov_throws, smoke_throws, decoy_throws,
    rounds_played
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
    COALESCE(mka.four_kill_rounds, 0), COALESCE(mka.five_kill_rounds, 0),
    COALESCE(tko.trade_kill_opportunities, 0),
    COALESCE(tka.trade_kill_attempts, 0),
    COALESCE(tka.trade_kill_successes, 0),
    COALESCE(tdo.traded_death_opportunities, 0),
    COALESCE(tda.traded_death_successes, 0),
    COALESCE(sa.shots_fired, 0),
    COALESCE(ha.hits, 0),         COALESCE(ha.headshot_hits, 0),
    COALESCE(ttd.time_to_damage_sum_s, 0),
    COALESCE(ttd.time_to_damage_count, 0),
    COALESCE(spa.spotted_count, 0),
    COALESCE(spa.spotted_with_damage_count, 0),
    COALESCE(ta.he_throws, 0),    COALESCE(ta.molotov_throws, 0),
    COALESCE(ta.smoke_throws, 0), COALESCE(ta.decoy_throws, 0),
    (SELECT rounds_played FROM rounds_played_const)
  FROM player_set ps
  LEFT JOIN kills_agg          ka  ON ka.steam_id  = ps.steam_id
  LEFT JOIN deaths_agg         da  ON da.steam_id  = ps.steam_id
  LEFT JOIN assists_agg        aa  ON aa.steam_id  = ps.steam_id
  LEFT JOIN damage_agg         dmg ON dmg.steam_id = ps.steam_id
  LEFT JOIN flash_agg          fa  ON fa.steam_id  = ps.steam_id
  LEFT JOIN utility_agg        ua  ON ua.steam_id  = ps.steam_id
  LEFT JOIN multi_k_agg        mka ON mka.steam_id = ps.steam_id
  LEFT JOIN trade_kill_agg     tka ON tka.steam_id = ps.steam_id
  LEFT JOIN trade_kill_opp_agg tko ON tko.steam_id = ps.steam_id
  LEFT JOIN traded_death_agg   tda ON tda.steam_id = ps.steam_id
  LEFT JOIN traded_death_opp_agg tdo ON tdo.steam_id = ps.steam_id
  LEFT JOIN shots_agg          sa  ON sa.steam_id  = ps.steam_id
  LEFT JOIN hits_agg           ha  ON ha.steam_id  = ps.steam_id
  LEFT JOIN ttd_agg            ttd ON ttd.steam_id = ps.steam_id
  LEFT JOIN spotted_agg        spa ON spa.steam_id = ps.steam_id
  LEFT JOIN throws_agg         ta  ON ta.steam_id  = ps.steam_id;
END;
$$;

-- Re-run only when this file's digest changes
SELECT public.recompute_all_player_match_map_stats();
