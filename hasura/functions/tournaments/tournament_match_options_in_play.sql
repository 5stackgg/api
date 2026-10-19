-- The settings that decide how a match is played. best_of is not listed: a
-- stage's rounds set it, and only a tournament match's own row freezes it.
CREATE OR REPLACE FUNCTION public.match_options_rule_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT ARRAY[
        'type',
        'map_pool_id',
        'map_veto',
        'mr',
        'overtime',
        'knife_round',
        'timeout_setting',
        'tech_timeout_setting',
        'coaches',
        'number_of_substitutes',
        'game_mode_id',
        'default_models',
        'halftime_pausematch',
        'round_restart_delay'
    ];
$$;

-- 'match' for a tournament match's own row, 'bracket' for a bracket's own row
-- once its pairing is known or its stage has a match, 'template' for a
-- tournament or stage row that a stage with matches plays, NULL otherwise.
-- A bracket's row is cloned as is, best_of included, so it locks like a match.
CREATE OR REPLACE FUNCTION public.tournament_match_options_in_play(_match_options_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM public.matches m
            INNER JOIN public.tournament_brackets tb ON tb.match_id = m.id
            WHERE m.match_options_id = _match_options_id
        ) THEN 'match'
        WHEN EXISTS (
            SELECT 1
            FROM public.tournament_brackets tb
            WHERE tb.match_options_id = _match_options_id
              AND (
                  tb.tournament_team_id_1 IS NOT NULL
                  OR tb.tournament_team_id_2 IS NOT NULL
                  OR EXISTS (
                      SELECT 1
                      FROM public.tournament_brackets played
                      WHERE played.tournament_stage_id = tb.tournament_stage_id
                        AND played.match_id IS NOT NULL
                  )
              )
        ) THEN 'bracket'
        WHEN EXISTS (
            SELECT 1
            FROM public.tournament_stages ts
            INNER JOIN public.tournament_brackets played ON played.tournament_stage_id = ts.id
            WHERE ts.match_options_id = _match_options_id
              AND played.match_id IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM public.tournaments t
            INNER JOIN public.tournament_stages ts ON ts.tournament_id = t.id
            INNER JOIN public.tournament_brackets played ON played.tournament_stage_id = ts.id
            WHERE t.match_options_id = _match_options_id
              AND ts.match_options_id IS NULL
              AND played.match_id IS NOT NULL
        ) THEN 'template'
    END;
$$;
