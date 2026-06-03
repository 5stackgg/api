-- Per-(match, player) HLTV rating — the canonical, backend single source for
-- the match-row rating on the player page. Rounds-weighted roll-up of the
-- per-map v_player_match_map_hltv, so it includes KAST and matches what the
-- match page shows (the client-side match-row formula omitted KAST, which read
-- ~0.5 too low). adr/kpr/dpr/kast carried for convenience.
--
-- Named "..._rating" (not "..._hltv") on purpose: views apply in sorted
-- filename order with no dependency resolution, and this must apply AFTER its
-- dependency v_player_match_map_hltv — "rating" > "map" so it sorts later.
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
