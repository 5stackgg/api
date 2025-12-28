CREATE OR REPLACE VIEW public.v_team_tournament_results AS
SELECT 
    tsr.tournament_team_id,
    ts.tournament_id,
    SUM(tsr.matches_played)::int as matches_played,
    SUM(tsr.matches_remaining)::int as matches_remaining,
    SUM(tsr.wins)::int as wins,
    SUM(tsr.losses)::int as losses,
    SUM(tsr.maps_won)::int as maps_won,
    SUM(tsr.maps_lost)::int as maps_lost,
    SUM(tsr.rounds_won)::int as rounds_won,
    SUM(tsr.rounds_lost)::int as rounds_lost,
    SUM(tsr.total_kills)::int as total_kills,
    SUM(tsr.total_deaths)::int as total_deaths,
    CASE 
        WHEN SUM(tsr.total_deaths) > 0 
        THEN (SUM(tsr.total_kills)::float / SUM(tsr.total_deaths)::float)
        ELSE SUM(tsr.total_kills)::float
    END as team_kdr,
    SUM(tsr.head_to_head_match_wins)::int as head_to_head_match_wins,
    SUM(tsr.head_to_head_rounds_won)::int as head_to_head_rounds_won
FROM v_team_stage_results tsr
JOIN tournament_stages ts ON ts.id = tsr.tournament_stage_id
GROUP BY tsr.tournament_team_id, ts.tournament_id
ORDER BY 
    SUM(tsr.wins) DESC,
    SUM(tsr.head_to_head_match_wins) DESC,
    SUM(tsr.head_to_head_rounds_won) DESC,
    CASE 
        WHEN SUM(tsr.maps_lost) > 0 
        THEN (SUM(tsr.maps_won)::float / SUM(tsr.maps_lost)::float)
        ELSE SUM(tsr.maps_won)::float
    END DESC,
    CASE 
        WHEN SUM(tsr.rounds_lost) > 0 
        THEN (SUM(tsr.rounds_won)::float / SUM(tsr.rounds_lost)::float)
        ELSE SUM(tsr.rounds_won)::float
    END DESC,
    CASE 
        WHEN SUM(tsr.total_deaths) > 0 
        THEN (SUM(tsr.total_kills)::float / SUM(tsr.total_deaths)::float)
        ELSE SUM(tsr.total_kills)::float
    END DESC;

    