-- In-match performance multiplier (0.8 - 1.2) driven by KDA-vs-team and damage share.
-- Stored as a level metric independent of ELO swings so MVP and similar
-- consumers can rank players without favoring those whose ELO moved most.
ALTER TABLE public.player_elo ADD COLUMN IF NOT EXISTS impact numeric;

-- Backfill from raw player_kills / player_assists / player_damages.
-- Mirrors the pre-loss-transform formula in get_player_elo_for_match.
WITH lineups AS (
    SELECT
        pe.steam_id,
        pe.match_id,
        (
            SELECT mlp.match_lineup_id
            FROM public.match_lineup_players mlp
            WHERE mlp.steam_id = pe.steam_id
              AND mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
            LIMIT 1
        ) AS player_lineup_id
    FROM public.player_elo pe
    JOIN public.matches m ON m.id = pe.match_id
    WHERE pe.impact IS NULL
),
metrics AS (
    SELECT
        l.steam_id,
        l.match_id,
        (SELECT COUNT(*) FROM public.player_kills pk
            WHERE pk.match_id = l.match_id AND pk.attacker_steam_id = l.steam_id) AS p_kills,
        (SELECT COUNT(*) FROM public.player_kills pk
            WHERE pk.match_id = l.match_id AND pk.attacked_steam_id = l.steam_id) AS p_deaths,
        (SELECT COUNT(*) FROM public.player_assists pa
            WHERE pa.match_id = l.match_id AND pa.attacker_steam_id = l.steam_id) AS p_assists,
        (SELECT COALESCE(SUM(pd.damage), 0) FROM public.player_damages pd
            WHERE pd.match_id = l.match_id AND pd.attacker_steam_id = l.steam_id) AS p_damage,
        (SELECT COUNT(*) FROM public.player_kills pk
            JOIN public.match_lineup_players mlp ON pk.attacker_steam_id = mlp.steam_id
            WHERE pk.match_id = l.match_id AND mlp.match_lineup_id = l.player_lineup_id) AS t_kills,
        (SELECT COUNT(*) FROM public.player_kills pk
            JOIN public.match_lineup_players mlp ON pk.attacked_steam_id = mlp.steam_id
            WHERE pk.match_id = l.match_id AND mlp.match_lineup_id = l.player_lineup_id) AS t_deaths,
        (SELECT COUNT(*) FROM public.player_assists pa
            JOIN public.match_lineup_players mlp ON pa.attacker_steam_id = mlp.steam_id
            WHERE pa.match_id = l.match_id AND mlp.match_lineup_id = l.player_lineup_id) AS t_assists,
        (SELECT COALESCE(SUM(pd.damage), 0) FROM public.player_damages pd
            JOIN public.match_lineup_players mlp ON pd.attacker_steam_id = mlp.steam_id
            WHERE pd.match_id = l.match_id AND mlp.match_lineup_id = l.player_lineup_id) AS t_damage
    FROM lineups l
    WHERE l.player_lineup_id IS NOT NULL
),
impact_calc AS (
    SELECT
        steam_id,
        match_id,
        GREATEST(0.8::numeric, LEAST(1.2::numeric,
            (
                1.0
                + (0.1 * (
                    ((p_kills + p_assists)::float / GREATEST(p_deaths, 1)::float)
                    / GREATEST((t_kills + t_assists)::float / GREATEST(t_deaths, 1)::float, 0.1)
                    - 1.0
                ))
                + (0.1 * (CASE WHEN t_damage > 0 THEN p_damage::float / t_damage::float ELSE 0 END - 0.2))
            )::numeric
        )) AS impact
    FROM metrics
)
UPDATE public.player_elo pe
SET impact = ic.impact
FROM impact_calc ic
WHERE pe.steam_id = ic.steam_id
  AND pe.match_id = ic.match_id;
