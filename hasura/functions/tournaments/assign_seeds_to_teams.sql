CREATE OR REPLACE FUNCTION public.assign_seeds_to_teams(tournament tournaments) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    min_players int;
BEGIN
    min_players := tournament_min_players_per_lineup(tournament);

    UPDATE tournament_teams tt
    SET eligible_at = CASE
            WHEN (SELECT COUNT(*) FROM tournament_team_roster ttr
                  WHERE ttr.tournament_team_id = tt.id) >= min_players
            THEN COALESCE(tt.eligible_at, NOW())
            ELSE NULL
        END,
        seed = CASE
            WHEN (SELECT COUNT(*) FROM tournament_team_roster ttr
                  WHERE ttr.tournament_team_id = tt.id) >= min_players
            THEN tt.seed
            ELSE NULL
        END
    WHERE tt.tournament_id = tournament.id;

    WITH eligible_count AS (
        SELECT COUNT(*) as total
        FROM tournament_teams
        WHERE tournament_id = tournament.id
          AND eligible_at IS NOT NULL
    ),
    taken_seeds AS (
        SELECT seed
        FROM tournament_teams
        WHERE tournament_id = tournament.id
          AND eligible_at IS NOT NULL
          AND seed IS NOT NULL
    ),
    available_seeds AS (
        SELECT s AS seed_number, ROW_NUMBER() OVER (ORDER BY RANDOM()) as rn
        FROM eligible_count ec
        CROSS JOIN LATERAL generate_series(1, ec.total::int) s
        WHERE s NOT IN (SELECT seed FROM taken_seeds)
    ),
    teams_to_seed AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY RANDOM()) as rn
        FROM tournament_teams
        WHERE tournament_id = tournament.id
          AND eligible_at IS NOT NULL
          AND seed IS NULL
    )
    UPDATE tournament_teams tt
    SET seed = avs.seed_number
    FROM teams_to_seed tts
    JOIN available_seeds avs ON avs.rn = tts.rn
    WHERE tt.id = tts.id;
END;
$$;