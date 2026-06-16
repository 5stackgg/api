CREATE OR REPLACE FUNCTION public._import_lineup_1_side(_round int, _mr int)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_r0        int;
  v_ot_mr     constant int := 6;
  v_ot_round  int;
  v_ot_number int;
  v_block     int;
  v_flip      boolean;
BEGIN
  -- Mirror of game-server TeamUtility.GetLineupSide (keep in sync).
  -- lineup_1 starts TERRORIST; GetLineupSide is 0-indexed, round_ticks 1-indexed.
  v_r0 := _round - 1;

  IF v_r0 < _mr * 2 THEN
    IF v_r0 < _mr THEN
      RETURN 'TERRORIST';
    END IF;
    RETURN 'CT';
  END IF;

  v_ot_round  := v_r0 - (_mr * 2);
  v_ot_number := (v_ot_round / v_ot_mr) + 1;
  v_block     := v_ot_round % v_ot_mr;

  IF (v_ot_number % 2) = 1 THEN
    v_flip := v_block < (v_ot_mr / 2);
  ELSE
    v_flip := v_block >= (v_ot_mr / 2);
  END IF;

  RETURN CASE WHEN v_flip THEN 'CT' ELSE 'TERRORIST' END;
END;
$$;

CREATE OR REPLACE FUNCTION public._import_normalize_side(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _raw ILIKE 't%' THEN 'TERRORIST'
    WHEN _raw ILIKE 'c%' THEN 'CT'
    ELSE NULL
  END;
$$;

-- Maps any weapon spelling to its canonical CS2 classname (= equipment icon
-- basename), keyed on a compact lowercase/alphanumeric form.
CREATE OR REPLACE FUNCTION public.canonical_weapon(_w text)
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

CREATE OR REPLACE FUNCTION public._import_normalize_weapon(_w text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.canonical_weapon(_w);
$$;

CREATE OR REPLACE FUNCTION public._import_round_end_reason(_code int)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- Demoinfocs RoundEndReason → e_winning_reasons enum.
  SELECT CASE _code
    WHEN 1  THEN 'BombExploded'
    WHEN 7  THEN 'BombDefused'
    WHEN 8  THEN 'CTsWin'
    WHEN 9  THEN 'TerroristsWin'
    WHEN 12 THEN 'TimeRanOut'
    ELSE 'Unknown'
  END;
$$;

CREATE OR REPLACE FUNCTION public.persist_imported_demo(
  p_match_map_demo_id uuid,
  p_parsed            jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_match_id          uuid;
  v_match_map_id      uuid;
  v_map_id            uuid;
  v_match_options_id  uuid;
  v_lineup_1_id       uuid;
  v_lineup_2_id       uuid;
  v_mr                int;
  v_tick_rate         real;
  v_start_time        timestamptz;
  v_winner_lineup_id  uuid;
  v_l1_score          int;
  v_l2_score          int;
  v_ended_at          timestamptz;
BEGIN
  SELECT mmd.match_id, mmd.match_map_id, m.match_options_id, m.lineup_1_id, m.lineup_2_id
    INTO v_match_id, v_match_map_id, v_match_options_id, v_lineup_1_id, v_lineup_2_id
    FROM public.match_map_demos mmd
    JOIN public.matches m ON m.id = mmd.match_id
   WHERE mmd.id = p_match_map_demo_id;

  IF v_match_id IS NULL THEN
    RETURN;
  END IF;

  SELECT mr INTO v_mr FROM public.match_options WHERE id = v_match_options_id;
  v_mr := COALESCE(v_mr, 12);

  -- Map for this demo — skill-group ranks (Competitive/Wingman) are per map.
  SELECT map_id INTO v_map_id FROM public.match_maps WHERE id = v_match_map_id;

  PERFORM public.persist_parsed_demo(p_match_map_demo_id, p_parsed);

  v_tick_rate := NULLIF((p_parsed->>'tick_rate'), '')::real;
  IF v_tick_rate IS NULL OR v_tick_rate <= 0 THEN
    v_tick_rate := 64.0;
  END IF;

  SELECT created_at INTO v_start_time FROM public.match_maps WHERE id = v_match_map_id;
  v_start_time := COALESCE(v_start_time, now());

  -- Skip the per-round recompute trigger; we recompute once at the end.
  PERFORM set_config('app.skip_round_recompute', 'on', true);

  DELETE FROM public.player_kills   WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_assists WHERE match_map_id = v_match_map_id;
  DELETE FROM public.player_damages WHERE match_map_id = v_match_map_id;
  DELETE FROM public.match_map_rounds WHERE match_map_id = v_match_map_id;

  WITH rounds AS (
    SELECT
      COALESCE((elem->>'round')::int, 0) AS round,
      COALESCE((elem->>'start_tick')::int, 0) AS start_tick,
      COALESCE((elem->>'end_tick')::int, 0) AS end_tick,
      NULLIF(elem->>'winner', '') AS winner,
      COALESCE((elem->>'reason')::int, 0) AS reason,
      (elem->>'ct_money')::int AS ct_money,
      (elem->>'t_money')::int AS t_money
    FROM jsonb_array_elements(COALESCE(p_parsed->'round_ticks', '[]'::jsonb)) elem
  ),
  with_sides AS (
    SELECT
      r.*,
      public._import_lineup_1_side(r.round, v_mr) AS lineup_1_side,
      CASE WHEN public._import_lineup_1_side(r.round, v_mr) = 'TERRORIST' THEN 'CT' ELSE 'TERRORIST' END AS lineup_2_side,
      CASE
        WHEN winner ILIKE 'T%' THEN 'TERRORIST'
        WHEN winner ILIKE 'C%' THEN 'CT'
        ELSE NULL
      END AS winning_side_norm
    FROM rounds r
  ),
  scored AS (
    SELECT
      *,
      SUM(CASE WHEN winning_side_norm = lineup_1_side THEN 1 ELSE 0 END)
        OVER (ORDER BY round) AS lineup_1_score,
      SUM(CASE WHEN winning_side_norm = lineup_2_side THEN 1 ELSE 0 END)
        OVER (ORDER BY round) AS lineup_2_score
    FROM with_sides
  )
  INSERT INTO public.match_map_rounds (
    match_map_id, round, time,
    lineup_1_score, lineup_2_score,
    lineup_1_money, lineup_2_money,
    lineup_1_timeouts_available, lineup_2_timeouts_available,
    lineup_1_side, lineup_2_side,
    winning_side, winning_reason
  )
  SELECT
    v_match_map_id, round,
    v_start_time + (end_tick::numeric / v_tick_rate::numeric) * interval '1 second',
    lineup_1_score, lineup_2_score,
    CASE WHEN lineup_1_side = 'CT' THEN COALESCE(ct_money, 0) ELSE COALESCE(t_money, 0) END,
    CASE WHEN lineup_2_side = 'CT' THEN COALESCE(ct_money, 0) ELSE COALESCE(t_money, 0) END,
    0, 0,
    lineup_1_side, lineup_2_side,
    COALESCE(winning_side_norm, lineup_1_side),
    public._import_round_end_reason(reason)
  FROM scored
  WHERE round > 0;

  INSERT INTO public.player_kills (
    match_id, match_map_id, round, time,
    attacker_steam_id, attacker_team,
    attacker_location, attacker_location_coordinates,
    attacked_steam_id, attacked_team,
    attacked_location, attacked_location_coordinates,
    "with", hitgroup,
    headshot, no_scope, thru_smoke, thru_wall, blinded, in_air, assisted
  )
  SELECT
    v_match_id, v_match_map_id,
    rt_match.round,
    v_start_time + ((elem->>'tick')::int::numeric / v_tick_rate::numeric) * interval '1 second',
    NULLIF(elem->>'killer', '')::bigint,
    NULLIF(elem->>'killer_team', ''),
    '',
    NULLIF(concat_ws(' ', elem->>'attacker_x', elem->>'attacker_y', elem->>'attacker_z'), ''),
    NULLIF(elem->>'victim', '')::bigint,
    COALESCE(NULLIF(elem->>'victim_team', ''), ''),
    '',
    NULLIF(concat_ws(' ', elem->>'victim_x', elem->>'victim_y', elem->>'victim_z'), ''),
    public._import_normalize_weapon(elem->>'weapon'),
    CASE WHEN COALESCE((elem->>'headshot')::boolean, false) THEN 'head' ELSE 'generic' END,
    COALESCE((elem->>'headshot')::boolean, false),
    COALESCE((elem->>'noscope')::boolean, false),
    COALESCE((elem->>'smoke')::boolean, false),
    COALESCE((elem->>'wallbang')::boolean, false),
    false, false,
    NULLIF(elem->>'assist', '') IS NOT NULL
  FROM jsonb_array_elements(COALESCE(p_parsed->'kills', '[]'::jsonb)) elem
  CROSS JOIN LATERAL (
    SELECT COALESCE((rt->>'round')::int, 0) AS round
    FROM jsonb_array_elements(COALESCE(p_parsed->'round_ticks', '[]'::jsonb)) rt
    WHERE (elem->>'tick')::int >= COALESCE((rt->>'start_tick')::int, 0)
      AND (elem->>'tick')::int <= COALESCE((rt->>'end_tick')::int, 2147483647)
    ORDER BY (rt->>'round')::int
    LIMIT 1
  ) rt_match
  WHERE NULLIF(elem->>'victim', '') IS NOT NULL
    AND NULLIF(elem->>'killer', '') IS NOT NULL;

  INSERT INTO public.player_assists (
    match_id, match_map_id, round, time,
    attacker_steam_id, attacker_team,
    attacked_steam_id, attacked_team,
    flash
  )
  SELECT
    v_match_id, v_match_map_id,
    rt_match.round,
    v_start_time + ((elem->>'tick')::int::numeric / v_tick_rate::numeric) * interval '1 second',
    NULLIF(elem->>'assist', '')::bigint,
    COALESCE(NULLIF(elem->>'killer_team', ''), ''),
    NULLIF(elem->>'victim', '')::bigint,
    COALESCE(NULLIF(elem->>'victim_team', ''), ''),
    COALESCE((elem->>'assist_flash')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_parsed->'kills', '[]'::jsonb)) elem
  CROSS JOIN LATERAL (
    SELECT COALESCE((rt->>'round')::int, 0) AS round
    FROM jsonb_array_elements(COALESCE(p_parsed->'round_ticks', '[]'::jsonb)) rt
    WHERE (elem->>'tick')::int >= COALESCE((rt->>'start_tick')::int, 0)
      AND (elem->>'tick')::int <= COALESCE((rt->>'end_tick')::int, 2147483647)
    ORDER BY (rt->>'round')::int
    LIMIT 1
  ) rt_match
  WHERE NULLIF(elem->>'assist', '') IS NOT NULL
    AND NULLIF(elem->>'victim', '') IS NOT NULL;

  INSERT INTO public.player_damages (
    match_id, match_map_id, round, time,
    attacker_steam_id, attacker_team,
    attacker_location,
    attacked_steam_id, attacked_team,
    attacked_location,
    "with", damage, damage_armor, health, armor, hitgroup
  )
  SELECT
    v_match_id, v_match_map_id,
    COALESCE((elem->>'round')::int, 0),
    v_start_time + ((elem->>'tick')::int::numeric / v_tick_rate::numeric) * interval '1 second',
    NULLIF(elem->>'attacker', '')::bigint,
    NULLIF(elem->>'attacker_team', ''),
    '',
    NULLIF(elem->>'victim', '')::bigint,
    COALESCE(NULLIF(elem->>'victim_team', ''), ''),
    '',
    public._import_normalize_weapon(elem->>'weapon'),
    COALESCE((elem->>'damage')::int, 0),
    COALESCE((elem->>'damage_armor')::int, 0),
    COALESCE((elem->>'health')::int, 0),
    0,
    COALESCE(elem->>'hitgroup', 'generic')
  FROM jsonb_array_elements(COALESCE(p_parsed->'damages', '[]'::jsonb)) elem
  WHERE NULLIF(elem->>'attacker', '') IS NOT NULL
    AND NULLIF(elem->>'victim', '') IS NOT NULL;

  -- One row per grenade throw → drives flashes_thrown + smokes_thrown
  -- etc in recompute. Each throw also implicitly accounts for utility
  -- "carried but unused" deduction at round end.
  DELETE FROM public.player_utility WHERE match_map_id = v_match_map_id;
  INSERT INTO public.player_utility (
    match_id, match_map_id, time, round, type, attacker_steam_id,
    attacker_location_coordinates
  )
  SELECT
    v_match_id, v_match_map_id,
    v_start_time + ((elem->>'tick')::int::numeric / v_tick_rate::numeric) * interval '1 second',
    COALESCE((elem->>'round')::int, 0),
    -- demoinfocs emits 'HE'; the FK to e_utility_types expects 'HighExplosive'.
    CASE elem->>'type' WHEN 'HE' THEN 'HighExplosive' ELSE elem->>'type' END,
    NULLIF(elem->>'thrower', '')::bigint,
    COALESCE(
      det.coords,
      NULLIF(concat_ws(',', elem->>'ox', elem->>'oy', elem->>'oz'), '')
    )
  FROM jsonb_array_elements(COALESCE(p_parsed->'grenade_throws', '[]'::jsonb)) elem
  LEFT JOIN LATERAL (
    SELECT NULLIF(concat_ws(',', d->>'x', d->>'y', d->>'z'), '') AS coords
    FROM jsonb_array_elements(COALESCE(p_parsed->'grenade_detonations', '[]'::jsonb)) d
    WHERE NULLIF(elem->>'gid', '') IS NOT NULL
      AND d->>'gid' = elem->>'gid'
    LIMIT 1
  ) det ON TRUE
  WHERE NULLIF(elem->>'thrower', '') IS NOT NULL
    AND NULLIF(elem->>'type', '') IS NOT NULL;

  -- One row per blinded player per flash → drives enemies_flashed,
  -- team_flashed, and avg blind time.
  DELETE FROM public.player_flashes WHERE match_map_id = v_match_map_id;
  INSERT INTO public.player_flashes (
    match_id, match_map_id, time, round,
    attacker_steam_id, attacked_steam_id, duration, team_flash
  )
  SELECT
    v_match_id, v_match_map_id,
    v_start_time + ((elem->>'tick')::int::numeric / v_tick_rate::numeric) * interval '1 second',
    COALESCE((elem->>'round')::int, 0),
    NULLIF(elem->>'attacker', '')::bigint,
    NULLIF(elem->>'victim', '')::bigint,
    COALESCE((elem->>'duration')::numeric, 0),
    COALESCE((elem->>'team_flash')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_parsed->'flashes', '[]'::jsonb)) elem
  WHERE NULLIF(elem->>'attacker', '') IS NOT NULL
    AND NULLIF(elem->>'victim', '') IS NOT NULL;

  -- Single recompute now that every per-event table is populated (the
  -- match_map_rounds trigger was skipped above via app.skip_round_recompute).
  PERFORM public.recompute_player_match_map_stats(v_match_map_id);

  -- Final scores + winner from the last round's cumulative score.
  SELECT lineup_1_score, lineup_2_score
    INTO v_l1_score, v_l2_score
    FROM public.match_map_rounds
   WHERE match_map_id = v_match_map_id
   ORDER BY round DESC
   LIMIT 1;

  IF COALESCE(v_l1_score, 0) > COALESCE(v_l2_score, 0) THEN
    v_winner_lineup_id := v_lineup_1_id;
  ELSIF COALESCE(v_l2_score, 0) > COALESCE(v_l1_score, 0) THEN
    v_winner_lineup_id := v_lineup_2_id;
  ELSE
    v_winner_lineup_id := NULL;
  END IF;

  -- Synthesize ended_at from the demo: match_map.created_at + the last
  -- round's end_tick. Falls back to created_at when the demo had no
  -- rounds finalized.
  SELECT v_start_time
       + (MAX(COALESCE((elem->>'end_tick')::int, 0))::numeric
          / v_tick_rate::numeric)
       * interval '1 second'
    INTO v_ended_at
    FROM jsonb_array_elements(COALESCE(p_parsed->'round_ticks', '[]'::jsonb)) elem;
  v_ended_at := COALESCE(v_ended_at, v_start_time);

  UPDATE public.match_maps
     SET status = 'Finished',
         winning_lineup_id = v_winner_lineup_id
   WHERE id = v_match_map_id;

  UPDATE public.matches
     SET winning_lineup_id = COALESCE(winning_lineup_id, v_winner_lineup_id),
         ended_at          = v_ended_at,
         started_at        = COALESCE(started_at, v_start_time)
   WHERE id = v_match_id;

  -- Per-match rank history: Wingman (6), Competitive (7/12), Premier (11).
  -- previous_rank is the player's prior rank of the same type (and map, for
  -- the per-map skill groups) so the per-match delta is exact.
  WITH ranked_players AS (
    SELECT
      (elem->>'steam_id')::bigint              AS steam_id,
      (elem->>'rank')::int                     AS rank,
      (elem->>'rank_type')::int                AS rank_type,
      NULLIF((elem->>'previous_rank')::int, 0) AS demo_previous_rank,
      CASE WHEN (elem->>'rank_type')::int = 11 THEN NULL ELSE v_map_id END AS map_id
    FROM jsonb_array_elements(COALESCE(p_parsed->'players', '[]'::jsonb)) elem
    WHERE (elem->>'rank_type')::int IN (6, 7, 11, 12)
      AND COALESCE((elem->>'rank')::int, 0) > 0
      AND elem->>'steam_id' IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.players p WHERE p.steam_id = (elem->>'steam_id')::bigint
      )
  )
  INSERT INTO public.player_premier_rank_history
    (steam_id, rank, rank_type, map_id, previous_rank, match_id, observed_at)
  SELECT
    rp.steam_id,
    rp.rank,
    rp.rank_type,
    rp.map_id,
    -- The demo's RankOld is the true pre-match rank; fall back to our own
    -- history (same type, and map for skill groups) when it's absent.
    COALESCE(
      rp.demo_previous_rank,
      (
        SELECT h.rank
          FROM public.player_premier_rank_history h
         WHERE h.steam_id = rp.steam_id
           AND h.rank_type = rp.rank_type
           AND h.match_id <> v_match_id
           AND h.observed_at < v_ended_at
           AND (rp.rank_type = 11 OR h.map_id = rp.map_id)
         ORDER BY h.observed_at DESC
         LIMIT 1
      )
    ),
    v_match_id,
    v_ended_at
    FROM ranked_players rp
  ON CONFLICT (steam_id, match_id, rank_type) DO UPDATE
    SET rank          = EXCLUDED.rank,
        map_id        = EXCLUDED.map_id,
        previous_rank = EXCLUDED.previous_rank,
        observed_at   = EXCLUDED.observed_at;

  -- Premier is the only global snapshot (Competitive/Wingman are per-map).
  -- The guard keeps an out-of-order import from clobbering a newer rating.
  UPDATE public.players p
     SET premier_rank = pp.rank,
         premier_rank_updated_at = v_ended_at
    FROM (
      SELECT (elem->>'steam_id')::bigint AS steam_id,
             (elem->>'rank')::int        AS rank
      FROM jsonb_array_elements(COALESCE(p_parsed->'players', '[]'::jsonb)) elem
      WHERE (elem->>'rank_type')::int = 11
        AND COALESCE((elem->>'rank')::int, 0) > 0
        AND elem->>'steam_id' IS NOT NULL
    ) pp
   WHERE p.steam_id = pp.steam_id
     AND (p.premier_rank_updated_at IS NULL OR p.premier_rank_updated_at <= v_ended_at);
END;
$$;
