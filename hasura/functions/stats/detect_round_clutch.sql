-- Detect a clutch (1vX) in a single round, mirroring the client algorithm:
-- walk the round's kills in order, removing victims from each lineup's alive
-- set (seeded from the roster). The first time a lineup drops to exactly one
-- alive while the other still has someone, that lone player is the clutcher.
-- Count their kills from that point; outcome = won (killed all opponents),
-- saved (team won the round anyway), or lost. Returns 0 or 1 row.
CREATE OR REPLACE FUNCTION public.detect_round_clutch(p_match_map_id uuid, p_round integer)
RETURNS TABLE (
  match_lineup_id uuid,
  clutcher_steam_id bigint,
  side text,
  against_count integer,
  kills_in_clutch integer,
  outcome text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_l1 uuid; v_l2 uuid;
  v_l1_side text; v_l2_side text; v_winning text;
  alive1 bigint[]; alive2 bigint[];
  rec record;
  started boolean := false;
  clutch_team integer := NULL;  -- 1 or 2
  v_clutcher bigint := NULL;
  v_against integer := 0;
  v_kills integer := 0;
  killed_all boolean := false;
  v_side text;
  v_won boolean;
BEGIN
  SELECT m.lineup_1_id, m.lineup_2_id,
         public.normalize_side(mmr.lineup_1_side),
         public.normalize_side(mmr.lineup_2_side),
         public.normalize_side(mmr.winning_side)
    INTO v_l1, v_l2, v_l1_side, v_l2_side, v_winning
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.match_map_id = p_match_map_id
    AND mmr.round = p_round
    AND mmr.deleted_at IS NULL;

  IF v_l1 IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(mlp.steam_id), '{}') INTO alive1
  FROM public.match_lineup_players mlp
  WHERE mlp.match_lineup_id = v_l1 AND mlp.steam_id IS NOT NULL;
  SELECT COALESCE(array_agg(mlp.steam_id), '{}') INTO alive2
  FROM public.match_lineup_players mlp
  WHERE mlp.match_lineup_id = v_l2 AND mlp.steam_id IS NOT NULL;

  FOR rec IN
    SELECT pk.attacker_steam_id AS killer, pk.attacked_steam_id AS victim
    FROM public.player_kills pk
    WHERE pk.match_map_id = p_match_map_id AND pk.round = p_round
    ORDER BY pk."time"
  LOOP
    alive1 := array_remove(alive1, rec.victim);
    alive2 := array_remove(alive2, rec.victim);

    IF started AND v_clutcher IS NOT NULL AND rec.killer = v_clutcher THEN
      v_kills := v_kills + 1;
    END IF;

    IF NOT started
       AND (COALESCE(array_length(alive1, 1), 0) = 1 OR COALESCE(array_length(alive2, 1), 0) = 1)
       AND COALESCE(array_length(alive1, 1), 0) > 0
       AND COALESCE(array_length(alive2, 1), 0) > 0 THEN
      started := true;
      IF COALESCE(array_length(alive1, 1), 0) = 1 THEN
        clutch_team := 1; v_clutcher := alive1[1]; v_against := COALESCE(array_length(alive2, 1), 0);
      ELSE
        clutch_team := 2; v_clutcher := alive2[1]; v_against := COALESCE(array_length(alive1, 1), 0);
      END IF;
    END IF;

    IF started THEN
      IF clutch_team = 1 AND COALESCE(array_length(alive2, 1), 0) = 0 THEN killed_all := true; EXIT; END IF;
      IF clutch_team = 2 AND COALESCE(array_length(alive1, 1), 0) = 0 THEN killed_all := true; EXIT; END IF;
      IF clutch_team = 1 AND COALESCE(array_length(alive1, 1), 0) = 0 THEN EXIT; END IF;
      IF clutch_team = 2 AND COALESCE(array_length(alive2, 1), 0) = 0 THEN EXIT; END IF;
    END IF;
  END LOOP;

  IF NOT started OR v_clutcher IS NULL THEN
    RETURN;
  END IF;

  IF clutch_team = 1 THEN
    match_lineup_id := v_l1; v_side := v_l1_side;
  ELSE
    match_lineup_id := v_l2; v_side := v_l2_side;
  END IF;

  v_won := (v_winning IS NOT NULL AND v_winning = v_side);
  IF killed_all THEN
    outcome := 'won';
  ELSIF v_won THEN
    outcome := 'saved';
  ELSE
    outcome := 'lost';
  END IF;

  clutcher_steam_id := v_clutcher;
  side := v_side;
  against_count := v_against;
  kills_in_clutch := v_kills;
  RETURN NEXT;
END;
$$;
