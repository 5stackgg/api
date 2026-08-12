DROP VIEW IF EXISTS v_team_ranks;

-- Team-ranks-only ELO, by match type. get_player_elo()/get_player_season_elo_by_type()
-- fall back to a player's lifetime-latest player_elo row when they have no row
-- for the active season. That is right for their other callers (matchmaking
-- balancing, the friends list, the players.elo GraphQL field), but the team
-- header should agree with what the profile shows for that case: the season
-- row if there is one, otherwise the season starting ELO -- never a stale
-- lifetime value. This helper applies that rule for v_team_ranks alone,
-- leaving the shared get_player_elo functions untouched.
CREATE OR REPLACE FUNCTION public._team_rank_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _active_season_id UUID;
    elo_value numeric;
BEGIN
    IF NOT seasons_enabled() THEN
        RETURN get_player_elo_by_type(player, _type);
    END IF;

    _active_season_id := get_active_season();

    -- Off-season gap (seasons enabled, none active): same convention
    -- get_player_elo() itself falls back to.
    IF _active_season_id IS NULL THEN
        RETURN get_player_elo_by_type(player, _type);
    END IF;

    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id
      AND "type" = _type
      AND season_id = _active_season_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- No row in the active season yet: season starting ELO, not their older rating.
    RETURN COALESCE(elo_value, 5000);
END;
$$;

-- Aggregate the same per-player values the app actually displays across the
-- current playing roster, so team page, team cards and the scrim finder all
-- agree. Players without a value are excluded from that average (NULL is
-- ignored) rather than dragged toward a default. Coaches are excluded
-- entirely -- they aren't playing roster members and shouldn't move the
-- team's rating. avg_elo keeps its Competitive meaning and name for existing
-- consumers; min_elo/max_elo stay Competitive-only.
CREATE OR REPLACE VIEW v_team_ranks AS
SELECT
    tr.team_id,
    count(*) AS roster_size,
    avg(e.competitive)::INTEGER AS avg_elo,
    min(e.competitive)::INTEGER AS min_elo,
    max(e.competitive)::INTEGER AS max_elo,
    avg(e.wingman)::INTEGER AS avg_wingman_elo,
    avg(e.duel)::INTEGER AS avg_duel_elo,
    round(avg(NULLIF(p.faceit_skill_level, 0)), 2)::FLOAT AS avg_faceit_level,
    avg(NULLIF(p.faceit_elo, 0))::INTEGER AS avg_faceit_elo,
    avg(NULLIF(p.premier_rank, 0))::INTEGER AS avg_premier
FROM team_roster tr
JOIN players p ON p.steam_id = tr.player_steam_id
LEFT JOIN LATERAL (
    SELECT
        NULLIF(_team_rank_elo_by_type(p, 'Competitive'), 0) AS competitive,
        NULLIF(_team_rank_elo_by_type(p, 'Wingman'), 0) AS wingman,
        NULLIF(_team_rank_elo_by_type(p, 'Duel'), 0) AS duel
) e ON true
WHERE tr.coach = false
GROUP BY tr.team_id;
