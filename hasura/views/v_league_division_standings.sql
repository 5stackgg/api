-- League division standings: a re-ranking of the cached tournament stage
-- results (v_team_stage_results, refreshed by recompute_tournament_stage_results
-- whenever matches finish) over the regular-season RoundRobin stage of each
-- division tournament, using the league tiebreak chain:
-- wins > head-to-head among tied > head-to-head rounds > round differential.
CREATE OR REPLACE VIEW public.v_league_division_standings AS
SELECT
    lsd.id AS league_season_division_id,
    lsd.league_season_id,
    lsd.league_division_id,
    lts.id AS league_team_season_id,
    lts.league_team_id,
    tsr.tournament_team_id,
    tsr.matches_played,
    tsr.matches_remaining,
    tsr.wins,
    tsr.losses,
    tsr.maps_won,
    tsr.maps_lost,
    tsr.rounds_won,
    tsr.rounds_lost,
    (tsr.rounds_won - tsr.rounds_lost) AS round_diff,
    tsr.head_to_head_match_wins,
    tsr.head_to_head_rounds_won,
    (ROW_NUMBER() OVER (
        PARTITION BY lsd.id
        ORDER BY
            tsr.wins DESC,
            tsr.head_to_head_match_wins DESC,
            tsr.head_to_head_rounds_won DESC,
            (tsr.rounds_won - tsr.rounds_lost) DESC,
            tsr.tournament_team_id
    ))::int AS rank
FROM public.league_season_divisions lsd
JOIN public.tournament_stages ts
  ON ts.tournament_id = lsd.tournament_id
 AND ts."order" = 1
JOIN public.v_team_stage_results tsr
  ON tsr.tournament_stage_id = ts.id
JOIN public.league_team_seasons lts
  ON lts.tournament_team_id = tsr.tournament_team_id
 AND lts.league_season_id = lsd.league_season_id;
