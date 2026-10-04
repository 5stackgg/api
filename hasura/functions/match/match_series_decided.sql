-- Winner-bracket advantage: when this match is the grand final of a
-- double-elimination stage, the winner-bracket team starts with a map-point
-- head start. Stays 0 (inert) for every other match.
-- The grand final is stored as path 'WB' at round wb_rounds+1 with no parent
-- (generate_double_elimination_bracket); 'GF' is only a round_best_of settings
-- key, never a stored path. A parentless WB bracket is NOT enough on its
-- own: a DE stage that passes 2+ teams to a next stage never creates a GF,
-- leaving each group's WB final parentless too — only the real GF has an
-- LB feeder as a child. assign_team_to_bracket_slot orders the WB feeder
-- ahead of the LB feeder, so the winner-bracket team is always slot 1 /
-- tournament_team_id_1, which schedule_tournament_match maps to lineup_1.
-- Clamped below the win threshold: at or above it the winner-bracket team
-- would take the match on the first finished map, even one it lost.
CREATE OR REPLACE FUNCTION public.match_final_map_advantage(_match_id uuid)
RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((
        SELECT LEAST(
            COALESCE(ts.final_map_advantage, 0),
            CEIL(mo.best_of / 2.0)::int - 1
        )
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN matches m ON m.id = tb.match_id
        INNER JOIN match_options mo ON mo.id = m.match_options_id
        WHERE tb.match_id = _match_id
          AND ts.type = 'DoubleElimination'
          AND tb.parent_bracket_id IS NULL
          AND COALESCE(tb.path, 'WB') = 'WB'
          AND EXISTS (
              SELECT 1
              FROM tournament_brackets lb
              WHERE lb.parent_bracket_id = tb.id
                AND lb.path = 'LB'
          )
        LIMIT 1
    ), 0);
$$;

-- The deciding map sits in WaitingForTV (tv_delay) and UploadingDemo before it
-- is Finished, and the match stays Live until then even though nothing is left
-- to play.
CREATE OR REPLACE FUNCTION public.match_series_decided(_match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT GREATEST(
        match_final_map_advantage(m.id)
            + COUNT(mm.id) FILTER (WHERE lineup_1_score(mm) > lineup_2_score(mm)),
        COUNT(mm.id) FILTER (WHERE lineup_2_score(mm) > lineup_1_score(mm))
    ) >= CEIL(mo.best_of / 2.0)
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN match_maps mm
        ON mm.match_id = m.id
       AND mm.status IN ('Finished', 'WaitingForTV', 'UploadingDemo')
    WHERE m.id = _match_id
    GROUP BY m.id, mo.best_of;
$$;
