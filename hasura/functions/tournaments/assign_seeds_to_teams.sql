-- eligible_at is the single gate the rest of the system respects:
-- tournament_has_min_teams counts it, the seeding below reads it, the UI shows
-- it. It is also RECOMPUTED here on every run, so a caller that nulls it out to
-- exclude a team has its work silently undone on the next pass. A missed
-- check-in therefore has to be folded into this function rather than applied
-- from outside -- and the team keeps its row and its roster, so an organizer
-- re-admits it by stamping checked_in_at and re-running the seeding. Nothing
-- deletes a no-show.
--
-- With check_in_required false the added predicate is constant true, so the
-- behaviour for every tournament that does not use check-in is unchanged.
CREATE OR REPLACE FUNCTION public.assign_seeds_to_teams(tournament tournaments) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    min_players int;
    _check_in_gate boolean;
BEGIN
    min_players := tournament_min_players_per_lineup(tournament);

    -- Gated on check_in_ends_at, which is stamped only when a window actually
    -- opened -- not on the derived "the clock has passed start - opens_before".
    -- Seeding runs in situations where no window ever opened (an organizer who
    -- closed registration early, a stage rebuild), and nobody is a no-show for
    -- a prompt that never appeared: with the derived form every team in such a
    -- tournament loses its seed the moment the clock crosses the threshold.
    _check_in_gate := tournament_check_in_window_opened(tournament);

    UPDATE tournament_teams tt
    SET eligible_at = CASE
            WHEN (SELECT COUNT(*) FROM tournament_team_roster ttr
                  WHERE ttr.tournament_team_id = tt.id) >= min_players
                 AND (NOT _check_in_gate OR tt.checked_in_at IS NOT NULL)
            THEN COALESCE(tt.eligible_at, NOW())
            ELSE NULL
        END,
        seed = CASE
            WHEN (SELECT COUNT(*) FROM tournament_team_roster ttr
                  WHERE ttr.tournament_team_id = tt.id) >= min_players
                 AND (NOT _check_in_gate OR tt.checked_in_at IS NOT NULL)
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
