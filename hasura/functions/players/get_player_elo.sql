-- Read from player_elo_current, which keeps the same latest unvoided rating
-- per ladder the per-type functions below look up. Seasons off: the lifetime
-- ladder alone (pre-seasons behavior). Seasons on: the active season's rating,
-- else the lifetime one, plus the tournament ladder.
CREATE OR REPLACE FUNCTION public.compute_player_elo(_steam_id bigint) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE WHEN s.seasons THEN jsonb_build_object(
            'competitive', COALESCE(sr.competitive, lr.competitive),
            'wingman', COALESCE(sr.wingman, lr.wingman),
            'duel', COALESCE(sr.duel, lr.duel),
            'rush', COALESCE(sr.rush, lr.rush),
            'tournament_competitive', tr.competitive,
            'tournament_wingman', tr.wingman,
            'tournament_duel', tr.duel,
            'tournament_rush', tr.rush)
        ELSE jsonb_build_object(
            'competitive', lr.competitive,
            'wingman', lr.wingman,
            'duel', lr.duel,
            'rush', lr.rush)
        END
    FROM (SELECT seasons_enabled() AS seasons, get_active_season() AS season_id) s
    LEFT JOIN player_elo_current lr ON lr.steam_id = _steam_id AND lr.ladder = 'lifetime'
    LEFT JOIN player_elo_current sr ON sr.steam_id = _steam_id AND sr.ladder = 'season' AND sr.season_id = s.season_id
    LEFT JOIN player_elo_current tr ON tr.steam_id = _steam_id AND tr.ladder = 'tournament';
$$;

-- What compute_player_elo answered, kept on players.elo_ratings
-- (player_elo_ratings.sql). One expression, so Postgres inlines it into the
-- query as a column read; a player not stored yet is worked out on the spot.
CREATE OR REPLACE FUNCTION public.get_player_elo(player public.players) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(player.elo_ratings, public.compute_player_elo(player.steam_id)) $$;

drop function if exists public.get_player_elo_by_type;

CREATE OR REPLACE FUNCTION public.get_player_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    -- A voided match's row only repeats the rating going in, so it is read as
    -- no row at all: a player whose only matches were voided has no rating.
    SELECT pe.current INTO elo_value
    FROM player_elo pe
    WHERE pe.steam_id = player.steam_id
    AND pe."type" = _type
    AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = pe.match_id AND m.elo_voided)
    ORDER BY pe.created_at DESC
    LIMIT 1;

    RETURN elo_value;
END;
$$;

-- Season ELO: latest ELO tagged to this season (season_id-indexed lookup; rows are
-- populated by the season backfill). Falls back to the player's lifetime ELO when
-- they have no rating in this season yet (e.g. the start of a new season) so the UI
-- shows their last known ELO instead of a blank.
CREATE OR REPLACE FUNCTION public.get_player_season_elo_by_type(player public.players, _type text, _season_id UUID) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    IF _season_id IS NOT NULL THEN
        SELECT pe.current INTO elo_value
        FROM player_elo pe
        WHERE pe.steam_id = player.steam_id
        AND pe."type" = _type
        AND pe.season_id = _season_id
        AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = pe.match_id AND m.elo_voided)
        ORDER BY pe.created_at DESC
        LIMIT 1;
    END IF;

    -- No season rating yet: fall back to lifetime (global) ELO for this type.
    IF elo_value IS NULL THEN
        elo_value := get_player_elo_by_type(player, _type);
    END IF;

    RETURN elo_value;
END;
$$;

-- Tournament ELO: latest ELO from tournament matches (season_id IS NULL and the
-- match in a bracket, which is_tournament records on the row).
CREATE OR REPLACE FUNCTION public.get_player_tournament_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    SELECT pe.current INTO elo_value
    FROM player_elo pe
    WHERE pe.steam_id = player.steam_id
    AND pe."type" = _type
    AND pe.season_id IS NULL
    AND pe.is_tournament
    AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = pe.match_id AND m.elo_voided)
    ORDER BY pe.created_at DESC
    LIMIT 1;

    RETURN elo_value;
END;
$$;
