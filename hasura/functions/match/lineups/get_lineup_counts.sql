CREATE OR REPLACE FUNCTION public.get_lineup_counts(match matches)
RETURNS json
LANGUAGE sql
STABLE
AS $$
    SELECT json_build_object(
        'lineup_1_count',
        (SELECT COUNT(*) FROM match_lineup_players WHERE match_lineup_id = match.lineup_1_id),
        'lineup_2_count',
        (SELECT COUNT(*) FROM match_lineup_players WHERE match_lineup_id = match.lineup_2_id)
    );
$$;
