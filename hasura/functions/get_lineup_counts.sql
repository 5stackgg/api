CREATE OR REPLACE FUNCTION public.get_lineup_counts(match matches) RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
    lineup_1_count INTEGER;
    lineup_2_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO lineup_1_count
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = match.lineup_1_id;

    SELECT COUNT(*) INTO lineup_2_count
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = match.lineup_2_id;

    RETURN json_build_object(
        'lineup_1_count', lineup_1_count,
        'lineup_2_count', lineup_2_count
    );
END;
$$;
