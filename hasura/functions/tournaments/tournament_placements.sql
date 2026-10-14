-- 1st, 2nd and 3rd, decided by the LAST stage: earlier stages are qualifiers,
-- and a team can go undefeated in Swiss yet lose the playoff final. The
-- medals and the podium both read it, so they can never disagree. A 3rd shared
-- by both semifinal losers (no third-place match) comes back as two rows.
CREATE OR REPLACE FUNCTION public.tournament_placements(_tournament_id uuid)
RETURNS TABLE (placement int, tournament_team_id uuid)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _final_stage_id uuid;
    _winning_team_id uuid;
    _runner_up_team_id uuid;
    _third_team_id uuid;
BEGIN
    SELECT id
      INTO _final_stage_id
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" DESC
    LIMIT 1;

    -- A last stage played in several groups has a winner per group and no
    -- single result to put on a podium or hand medals for.
    IF _final_stage_id IS NULL
       OR (SELECT COALESCE(ts.groups, 1) FROM public.tournament_stages ts
           WHERE ts.id = _final_stage_id) > 1 THEN
        RETURN;
    END IF;

    -- With a third-place decider the brackets order the medals directly. The
    -- standings cannot: the runner-up and the decider's winner both finish
    -- 1-1, so wins-based tiebreakers would pick silver and bronze arbitrarily.
    SELECT
        CASE WHEN fm.winning_lineup_id = fm.lineup_1_id
             THEN fb.tournament_team_id_1 ELSE fb.tournament_team_id_2 END,
        CASE WHEN fm.winning_lineup_id = fm.lineup_1_id
             THEN fb.tournament_team_id_2 ELSE fb.tournament_team_id_1 END,
        CASE WHEN tm.winning_lineup_id = tm.lineup_1_id
             THEN tb3.tournament_team_id_1 ELSE tb3.tournament_team_id_2 END
      INTO _winning_team_id, _runner_up_team_id, _third_team_id
    FROM public.tournament_stages ts
    JOIN public.tournament_brackets fb
      ON fb.tournament_stage_id = ts.id
    JOIN public.matches fm ON fm.id = fb.match_id
    JOIN public.tournament_brackets tb3
      ON tb3.tournament_stage_id = ts.id
     AND tb3.round = fb.round
     AND tb3.match_number = 2
     AND tb3.path = 'WB'
    JOIN public.matches tm ON tm.id = tb3.match_id
    WHERE ts.id = _final_stage_id
      AND ts.type = 'SingleElimination'
      AND ts.third_place_match = true
      AND fb.path = 'WB'
      AND fb.match_number = 1
      AND fb.round = (
          SELECT MAX(round) FROM public.tournament_brackets
          WHERE tournament_stage_id = _final_stage_id AND path = 'WB'
      )
      AND fm.winning_lineup_id IS NOT NULL
      AND tm.winning_lineup_id IS NOT NULL;

    IF _winning_team_id IS NOT NULL THEN
        placement := 1;
        tournament_team_id := _winning_team_id;
        RETURN NEXT;
        IF _runner_up_team_id IS NOT NULL THEN
            placement := 2;
            tournament_team_id := _runner_up_team_id;
            RETURN NEXT;
        END IF;
        IF _third_team_id IS NOT NULL
           AND _third_team_id IS DISTINCT FROM _winning_team_id
           AND _third_team_id IS DISTINCT FROM _runner_up_team_id THEN
            placement := 3;
            tournament_team_id := _third_team_id;
            RETURN NEXT;
        END IF;
        RETURN;
    END IF;

    -- Single elimination without a decider: the final orders 1st and 2nd, and
    -- both semifinal losers share 3rd. The standings would split them on round
    -- ratio, KDR and finally team id, none of which they played for.
    IF EXISTS (
        SELECT 1 FROM public.tournament_stages ts
        WHERE ts.id = _final_stage_id
          AND ts.type = 'SingleElimination'
    ) THEN
        RETURN QUERY
        WITH final_round AS (
            SELECT MAX(tb.round) AS round
            FROM public.tournament_brackets tb
            WHERE tb.tournament_stage_id = _final_stage_id
              AND tb.path = 'WB'
        ),
        decided AS (
            SELECT tb.round, tb.match_number,
                   CASE WHEN m.winning_lineup_id = m.lineup_1_id
                        THEN tb.tournament_team_id_1 ELSE tb.tournament_team_id_2 END AS winner,
                   CASE WHEN m.winning_lineup_id = m.lineup_1_id
                        THEN tb.tournament_team_id_2 ELSE tb.tournament_team_id_1 END AS loser
            FROM public.tournament_brackets tb
            JOIN public.matches m ON m.id = tb.match_id
            CROSS JOIN final_round fr
            WHERE tb.tournament_stage_id = _final_stage_id
              AND tb.path = 'WB'
              AND tb.round IN (fr.round, fr.round - 1)
              AND m.winning_lineup_id IS NOT NULL
        )
        SELECT 1, d.winner FROM decided d, final_round fr
         WHERE d.round = fr.round AND d.match_number = 1
        UNION ALL
        SELECT 2, d.loser FROM decided d, final_round fr
         WHERE d.round = fr.round AND d.match_number = 1 AND d.loser IS NOT NULL
        UNION ALL
        SELECT 3, d.loser FROM decided d, final_round fr
         WHERE d.round = fr.round - 1 AND d.loser IS NOT NULL
        ORDER BY 1, 2;
        RETURN;
    END IF;

    -- Otherwise v_team_stage_results orders the field (DE by elimination round,
    -- RR/Swiss by wins-based tiebreakers).
    RETURN QUERY
    SELECT r.placement::int, r.tournament_team_id
    FROM public.v_team_stage_results r
    WHERE r.tournament_stage_id = _final_stage_id
      AND r.placement IN (1, 2, 3)
    ORDER BY r.placement, r.tournament_team_id::text;
END;
$$;

-- The finished tournament's podium for the web: each placing team with the
-- players who played for it (tournament_team_medalists), whether or not
-- awards are handed out. Steam ids as text, since they overflow a JS number.
CREATE OR REPLACE FUNCTION public.tournament_podium(tournament public.tournaments)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN tournament.status IS DISTINCT FROM 'Finished' THEN NULL
        ELSE COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'placement', p.placement,
                    'tournament_team_id', p.tournament_team_id,
                    'team_id', tt.team_id,
                    'name', COALESCE(t.name, tt.name),
                    'players', COALESCE((
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'steam_id', pl.steam_id::text,
                                'name', pl.name,
                                'avatar_url', pl.avatar_url,
                                'custom_avatar_url', pl.custom_avatar_url,
                                'country', pl.country
                            ) ORDER BY pl.name
                        )
                        FROM public.tournament_team_medalists(tournament.id, p.tournament_team_id) m
                        JOIN public.players pl ON pl.steam_id = m.player_steam_id
                    ), '[]'::jsonb)
                ) ORDER BY p.placement, COALESCE(t.name, tt.name)
            )
            FROM public.tournament_placements(tournament.id) p
            JOIN public.tournament_teams tt ON tt.id = p.tournament_team_id
            LEFT JOIN public.teams t ON t.id = tt.team_id
        ), '[]'::jsonb)
    END;
$$;
