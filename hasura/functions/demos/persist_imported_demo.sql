CREATE OR REPLACE FUNCTION public._import_lineup_1_side(_round int, _mr int)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_ot_half int;
BEGIN
  IF _round <= _mr THEN
    RETURN 'TERRORIST';
  ELSIF _round <= _mr * 2 THEN
    RETURN 'CT';
  END IF;
  -- Overtime is mr3 in Valve MM — every 3 rounds the side swaps,
  -- starting with lineup_1 on T for the first OT half.
  v_ot_half := ((_round - _mr * 2 - 1) / 3);
  IF (v_ot_half % 2) = 0 THEN
    RETURN 'TERRORIST';
  ELSE
    RETURN 'CT';
  END IF;
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

CREATE OR REPLACE FUNCTION public._import_normalize_weapon(_w text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- demoinfocs prints user-facing names ("HE Grenade", "Molotov", …);
  -- the live game-server plugin writes short internal identifiers
  -- ("hegrenade", "molotov", …) which is what recompute filters by.
  SELECT CASE
    WHEN _w IS NULL THEN NULL
    WHEN _w ILIKE 'HE Grenade%'      THEN 'hegrenade'
    WHEN _w = 'Molotov'              THEN 'molotov'
    WHEN _w = 'Incendiary Grenade'   THEN 'inferno'
    WHEN _w = 'Smoke Grenade'        THEN 'smokegrenade'
    WHEN _w = 'Flashbang'            THEN 'flashbang'
    WHEN _w = 'Decoy Grenade'        THEN 'decoy'
    WHEN _w = 'Zeus x27' OR _w = 'Taser' THEN 'taser'
    WHEN _w ILIKE '%knife%' OR _w = 'Bayonet' THEN 'knife'
    ELSE LOWER(REPLACE(_w, ' ', ''))
  END;
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

  PERFORM public.persist_parsed_demo(p_match_map_demo_id, p_parsed);

  v_tick_rate := NULLIF((p_parsed->>'tick_rate'), '')::real;
  IF v_tick_rate IS NULL OR v_tick_rate <= 0 THEN
    v_tick_rate := 64.0;
  END IF;

  SELECT created_at INTO v_start_time FROM public.match_maps WHERE id = v_match_map_id;
  v_start_time := COALESCE(v_start_time, now());

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
      COALESCE((elem->>'reason')::int, 0) AS reason
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
    0, 0, 0, 0,
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
    '', '',
    NULLIF(elem->>'victim', '')::bigint,
    COALESCE(NULLIF(elem->>'victim_team', ''), ''),
    '', '',
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
    false
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
    match_id, match_map_id, time, round, type, attacker_steam_id
  )
  SELECT
    v_match_id, v_match_map_id,
    v_start_time + ((elem->>'tick')::int::numeric / v_tick_rate::numeric) * interval '1 second',
    COALESCE((elem->>'round')::int, 0),
    -- demoinfocs emits 'HE'; the FK to e_utility_types expects 'HighExplosive'.
    CASE elem->>'type' WHEN 'HE' THEN 'HighExplosive' ELSE elem->>'type' END,
    NULLIF(elem->>'thrower', '')::bigint
  FROM jsonb_array_elements(COALESCE(p_parsed->'grenade_throws', '[]'::jsonb)) elem
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

  -- The match_map_rounds insert above fired tai_match_map_rounds → recompute,
  -- but that ran before the per-event tables were populated. Force a final
  -- recompute now so player_match_map_stats reflects kills/damage/utility.
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

  WITH premier_players AS (
    SELECT
      (elem->>'steam_id')::bigint AS steam_id,
      (elem->>'rank')::int        AS rank
    FROM jsonb_array_elements(COALESCE(p_parsed->'players', '[]'::jsonb)) elem
    WHERE (elem->>'rank_type')::int = 11
      AND COALESCE((elem->>'rank')::int, 0) > 0
      AND elem->>'steam_id' IS NOT NULL
  )
  INSERT INTO public.player_premier_rank_history (steam_id, rank, match_id, observed_at)
  SELECT pp.steam_id, pp.rank, v_match_id, v_ended_at
    FROM premier_players pp
   WHERE EXISTS (SELECT 1 FROM public.players p WHERE p.steam_id = pp.steam_id)
  ON CONFLICT (steam_id, match_id) DO UPDATE
    SET rank = EXCLUDED.rank,
        observed_at = EXCLUDED.observed_at;

  UPDATE public.players p
     SET premier_rank = pp.rank,
         premier_rank_updated_at = v_ended_at
    FROM (
      SELECT
        (elem->>'steam_id')::bigint AS steam_id,
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
