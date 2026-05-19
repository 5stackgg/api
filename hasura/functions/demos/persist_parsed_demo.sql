CREATE OR REPLACE FUNCTION public.persist_parsed_demo(
  p_match_map_demo_id uuid,
  p_parsed            jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_match_id     uuid;
  v_match_map_id uuid;
BEGIN
  SELECT match_id, match_map_id
    INTO v_match_id, v_match_map_id
    FROM public.match_map_demos
   WHERE id = p_match_map_demo_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.match_map_demos SET
    total_ticks        = NULLIF(p_parsed->>'total_ticks', '')::int,
    tick_rate          = NULLIF(p_parsed->>'tick_rate', '')::real,
    round_ticks        = COALESCE(p_parsed->'round_ticks', '[]'::jsonb),
    kills              = COALESCE(p_parsed->'kills', '[]'::jsonb),
    bombs              = COALESCE(p_parsed->'bombs', '[]'::jsonb),
    players            = COALESCE(p_parsed->'players', '[]'::jsonb),
    map_name           = NULLIF(p_parsed->>'map_name', ''),
    workshop_id        = NULLIF(p_parsed->>'workshop_id', ''),
    cs2_build          = NULLIF(p_parsed->>'cs2_build', ''),
    metadata_parsed_at = now()
   WHERE id = p_match_map_demo_id;

  DELETE FROM public.player_shots_fired       WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_spotted           WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_grenade_throws    WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_aim_stats_demo    WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_round_inventory   WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_positions         WHERE match_map_id = v_match_map_id;

  INSERT INTO public.player_positions
    (match_id, match_map_id, round, tick, attacker_steam_id, attacker_team,
     alive, x, y, z, yaw)
  SELECT
    v_match_id,
    v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    (elem->>'tick')::int,
    (elem->>'attacker')::bigint,
    NULLIF(elem->>'team', ''),
    COALESCE((elem->>'alive')::boolean, false),
    (elem->>'x')::real,
    (elem->>'y')::real,
    (elem->>'z')::real,
    NULLIF(elem->>'yaw', '')::real
  FROM jsonb_array_elements(COALESCE(p_parsed->'positions', '[]'::jsonb)) elem
  WHERE NULLIF(elem->>'attacker', '') IS NOT NULL;

  INSERT INTO public.player_round_inventory
    (match_id, match_map_id, round, attacker_steam_id, attacker_team,
     flash, smoke, he, molotov, decoy)
  SELECT
    v_match_id,
    v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    (elem->>'attacker')::bigint,
    NULLIF(elem->>'team', ''),
    COALESCE((elem->>'flash')::int, 0),
    COALESCE((elem->>'smoke')::int, 0),
    COALESCE((elem->>'he')::int, 0),
    COALESCE((elem->>'molotov')::int, 0),
    COALESCE((elem->>'decoy')::int, 0)
  FROM jsonb_array_elements(COALESCE(p_parsed->'round_inventory', '[]'::jsonb)) elem
  WHERE NULLIF(elem->>'attacker', '') IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO public.player_shots_fired
    (match_id, match_map_id, round, tick, attacker_steam_id, attacker_team, "with", ammo_in_magazine)
  SELECT
    v_match_id,
    v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    (elem->>'tick')::int,
    (elem->>'attacker')::bigint,
    NULLIF(elem->>'attacker_team', ''),
    NULLIF(elem->>'weapon', ''),
    NULLIF(elem->>'ammo_in_magazine', '')::int
  FROM jsonb_array_elements(COALESCE(p_parsed->'shots_fired', '[]'::jsonb)) elem
  WHERE NULLIF(elem->>'attacker', '') IS NOT NULL;

  WITH
    shots AS (
      SELECT
        (elem->>'attacker')::bigint AS attacker,
        COALESCE((elem->>'is_rifle')::boolean, false)      AS is_rifle,
        COALESCE((elem->>'is_crouched')::boolean, false)   AS is_crouched,
        COALESCE((elem->>'enemy_spotted')::boolean, false) AS enemy_spotted,
        COALESCE((elem->>'is_spray')::boolean, false)      AS is_spray,
        CASE WHEN jsonb_typeof(elem->'was_stopped') = 'boolean'
             THEN (elem->>'was_stopped')::boolean END      AS was_stopped
      FROM jsonb_array_elements(COALESCE(p_parsed->'shots_fired', '[]'::jsonb)) elem
      WHERE NULLIF(elem->>'attacker', '') IS NOT NULL
    ),
    shots_agg AS (
      SELECT
        attacker,
        COUNT(*) FILTER (WHERE enemy_spotted)                                                            AS shots_at_spotted,
        COUNT(*) FILTER (WHERE is_rifle AND NOT is_crouched AND enemy_spotted)                           AS counter_strafe_eligible,
        COUNT(*) FILTER (WHERE is_rifle AND NOT is_crouched AND enemy_spotted AND was_stopped IS TRUE)   AS counter_strafed_shots,
        COUNT(*) FILTER (WHERE is_spray)                                                                 AS spray_shots
      FROM shots
      GROUP BY attacker
    ),
    damages AS (
      SELECT
        (elem->>'attacker')::bigint AS attacker,
        NULLIF(elem->>'attacker_team', '') AS attacker_team,
        NULLIF(elem->>'victim_team', '')   AS victim_team,
        NULLIF(elem->>'weapon', '')        AS weapon,
        (elem->>'hitgroup')::int           AS hitgroup,
        COALESCE((elem->>'round')::int, 0) AS round,
        COALESCE((elem->>'hit_on_spotted')::boolean, false) AS hit_on_spotted,
        COALESCE((elem->>'from_spray')::boolean, false)     AS from_spray,
        CASE WHEN jsonb_typeof(elem->'spot_to_damage') = 'number'
             THEN (elem->>'spot_to_damage')::numeric END AS spot_to_damage,
        CASE WHEN jsonb_typeof(elem->'crosshair_delta_deg') = 'number'
             THEN (elem->>'crosshair_delta_deg')::numeric END AS crosshair_delta
      FROM jsonb_array_elements(COALESCE(p_parsed->'damages', '[]'::jsonb)) elem
      WHERE NULLIF(elem->>'attacker', '') IS NOT NULL
        AND NULLIF(elem->>'victim', '')   IS NOT NULL
        AND (
          NULLIF(elem->>'attacker_team', '') IS NULL
          OR NULLIF(elem->>'victim_team', '') IS NULL
          OR elem->>'attacker_team' <> elem->>'victim_team'
        )
    ),
    damages_agg AS (
      SELECT
        attacker,
        COUNT(*)                                                                                AS hits,
        COUNT(*) FILTER (WHERE hitgroup = 1 AND weapon IS DISTINCT FROM 'awp')                  AS headshot_hits,
        COUNT(*) FILTER (WHERE weapon IS DISTINCT FROM 'awp')                                   AS non_awp_hits,
        COUNT(*) FILTER (WHERE hit_on_spotted)                                                  AS hits_at_spotted,
        COUNT(*) FILTER (WHERE from_spray)                                                      AS spray_hits,
        COALESCE(SUM(spot_to_damage), 0)                                                        AS ttd_sum,
        COUNT(*) FILTER (WHERE spot_to_damage IS NOT NULL)                                      AS ttd_count,
        COALESCE(SUM(crosshair_delta), 0)                                                       AS crosshair_sum,
        COUNT(*) FILTER (WHERE crosshair_delta IS NOT NULL)                                     AS crosshair_count
      FROM damages
      WHERE round > 0
      GROUP BY attacker
    ),
    attackers AS (
      SELECT attacker FROM shots_agg
      UNION
      SELECT attacker FROM damages_agg
    )
  INSERT INTO public.player_aim_stats_demo (
    match_id, match_map_id, attacker_steam_id,
    hits, headshot_hits, non_awp_hits, hits_at_spotted,
    shots_at_spotted, counter_strafe_eligible_shots, counter_strafed_shots,
    spray_shots, spray_hits,
    crosshair_angle_sum_deg, crosshair_angle_count,
    time_to_damage_sum_s, time_to_damage_count
  )
  SELECT
    v_match_id, v_match_map_id, a.attacker,
    COALESCE(da.hits, 0),
    COALESCE(da.headshot_hits, 0),
    COALESCE(da.non_awp_hits, 0),
    COALESCE(da.hits_at_spotted, 0),
    COALESCE(sa.shots_at_spotted, 0),
    COALESCE(sa.counter_strafe_eligible, 0),
    COALESCE(sa.counter_strafed_shots, 0),
    COALESCE(sa.spray_shots, 0),
    COALESCE(da.spray_hits, 0),
    COALESCE(da.crosshair_sum, 0),
    COALESCE(da.crosshair_count, 0),
    COALESCE(da.ttd_sum, 0),
    COALESCE(da.ttd_count, 0)
  FROM attackers a
  LEFT JOIN shots_agg   sa ON sa.attacker = a.attacker
  LEFT JOIN damages_agg da ON da.attacker = a.attacker;

  INSERT INTO public.player_spotted
    (match_id, match_map_id, round, tick, spotter_steam_id, spotted_steam_id, spotter_team)
  SELECT
    v_match_id,
    v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    (elem->>'tick')::int,
    (elem->>'spotter')::bigint,
    (elem->>'spotted')::bigint,
    NULLIF(elem->>'spotter_team', '')
  FROM jsonb_array_elements(COALESCE(p_parsed->'spotted', '[]'::jsonb)) elem
  WHERE NULLIF(elem->>'spotter', '') IS NOT NULL
    AND NULLIF(elem->>'spotted', '') IS NOT NULL;

  INSERT INTO public.player_grenade_throws
    (match_id, match_map_id, round, tick, thrower_steam_id, thrower_team, type, phase, x, y, z)
  SELECT
    v_match_id,
    v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    (elem->>'tick')::int,
    NULLIF(elem->>'thrower', '')::bigint,
    NULLIF(elem->>'thrower_team', ''),
    elem->>'type',
    'thrown',
    NULLIF(elem->>'ox', '')::numeric,
    NULLIF(elem->>'oy', '')::numeric,
    NULLIF(elem->>'oz', '')::numeric
  FROM jsonb_array_elements(COALESCE(p_parsed->'grenade_throws', '[]'::jsonb)) elem
  UNION ALL
  SELECT
    v_match_id,
    v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    (elem->>'tick')::int,
    NULLIF(elem->>'thrower', '')::bigint,
    NULLIF(elem->>'thrower_team', ''),
    elem->>'type',
    'detonated',
    NULLIF(elem->>'x', '')::numeric,
    NULLIF(elem->>'y', '')::numeric,
    NULLIF(elem->>'z', '')::numeric
  FROM jsonb_array_elements(COALESCE(p_parsed->'grenade_detonations', '[]'::jsonb)) elem;

  PERFORM public.recompute_player_match_map_stats(v_match_map_id);
END;
$$;
