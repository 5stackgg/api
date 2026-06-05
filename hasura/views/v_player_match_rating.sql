-- Named "..._rating" so it sorts AFTER its dependency v_player_match_map_hltv:
-- views apply in filename order with no dependency resolution.
CREATE OR REPLACE VIEW public.v_player_match_rating AS
SELECT
    h.match_id,
    h.steam_id,
    SUM(h.rounds_played)::int AS rounds_played,
    ROUND(SUM(h.hltv_rating * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0), 2) AS hltv_rating,
    ROUND(SUM(h.adr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0), 1) AS adr,
    ROUND(SUM(h.kpr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0), 2) AS kpr,
    ROUND(SUM(h.dpr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0), 2) AS dpr,
    ROUND(SUM(h.kast_pct * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0), 1) AS kast_pct
FROM v_player_match_map_hltv h
GROUP BY h.match_id, h.steam_id;
