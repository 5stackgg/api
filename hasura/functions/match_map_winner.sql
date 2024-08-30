CREATE OR REPLACE FUNCTION public.get_match_map_winning_lineup_id(match_map match_maps)
RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    lineup_id uuid;
BEGIN
    IF match_map.status != 'Finished' THEN
        RETURN NULL;
    END IF;

    SELECT
        CASE
            WHEN mmr.lineup_1_score > mmr.lineup_2_score THEN m.lineup_1_id
            WHEN mmr.lineup_1_score < mmr.lineup_2_score THEN m.lineup_2_id
            ELSE NULL
        END AS winner
    INTO lineup_id
    FROM
        match_maps mm
    INNER JOIN
        matches m ON m.id = mm.match_id
    INNER JOIN
        match_map_rounds mmr ON mmr.match_map_id = mm.id
    WHERE
        mm.id = match_map.id
    AND mmr.round = (
        SELECT MAX(round)
        FROM match_map_rounds
        WHERE match_map_id = mm.id
    );

    RETURN lineup_id;
END;
$$;

