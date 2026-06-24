DROP VIEW IF EXISTS v_team_ranks;

-- Aggregate the same per-player values the app actually displays
-- (get_player_elo + the players faceit/premier columns) across the full
-- roster, so team page, team cards and the scrim finder all agree. Players
-- without a value are simply excluded from that average (NULL is ignored),
-- rather than dragged toward a default.
CREATE OR REPLACE VIEW v_team_ranks AS
SELECT
    tr.team_id,
    count(*) AS roster_size,
    avg(e.competitive)::INTEGER AS avg_elo,
    min(e.competitive)::INTEGER AS min_elo,
    max(e.competitive)::INTEGER AS max_elo,
    round(avg(NULLIF(p.faceit_skill_level, 0)), 2)::FLOAT AS avg_faceit_level,
    avg(NULLIF(p.faceit_elo, 0))::INTEGER AS avg_faceit_elo,
    avg(NULLIF(p.premier_rank, 0))::INTEGER AS avg_premier
FROM team_roster tr
JOIN players p ON p.steam_id = tr.player_steam_id
LEFT JOIN LATERAL (
    SELECT NULLIF((get_player_elo(p) ->> 'competitive')::numeric, 0) AS competitive
) e ON true
GROUP BY tr.team_id;
