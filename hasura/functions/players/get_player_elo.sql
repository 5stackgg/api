-- Read from player_elo_current, which keeps the same latest unvoided rating
-- per ladder the per-type functions below look up. Seasons off: the lifetime
-- ladder alone (pre-seasons behavior). Seasons on: the active season's rating,
-- plus the tournament ladder. A type the player has been rated in but not yet
-- this season reads 5000, the rating their next match is rated from -- never
-- the lifetime row, which can be a tournament or last-season rating that the
-- next match then appears to wipe out. Between seasons it is the lifetime one.
CREATE OR REPLACE FUNCTION public.compute_player_elo(_steam_id bigint) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE WHEN s.seasons THEN jsonb_build_object(
            'competitive', COALESCE(sr.competitive, CASE WHEN s.season_id IS NULL THEN lr.competitive WHEN lr.competitive IS NOT NULL THEN 5000 END),
            'wingman', COALESCE(sr.wingman, CASE WHEN s.season_id IS NULL THEN lr.wingman WHEN lr.wingman IS NOT NULL THEN 5000 END),
            'duel', COALESCE(sr.duel, CASE WHEN s.season_id IS NULL THEN lr.duel WHEN lr.duel IS NOT NULL THEN 5000 END),
            'rush', COALESCE(sr.rush, CASE WHEN s.season_id IS NULL THEN lr.rush WHEN lr.rush IS NOT NULL THEN 5000 END),
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
-- populated by the season backfill), else 5000 for a type they have been rated in,
-- as compute_player_elo answers. Lifetime ELO when there is no season.
CREATE OR REPLACE FUNCTION public.get_player_season_elo_by_type(player public.players, _type text, _season_id UUID) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    IF _season_id IS NULL THEN
        RETURN get_player_elo_by_type(player, _type);
    END IF;

    SELECT pe.current INTO elo_value
    FROM player_elo pe
    WHERE pe.steam_id = player.steam_id
    AND pe."type" = _type
    AND pe.season_id = _season_id
    AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = pe.match_id AND m.elo_voided)
    ORDER BY pe.created_at DESC
    LIMIT 1;

    IF elo_value IS NULL AND get_player_elo_by_type(player, _type) IS NOT NULL THEN
        elo_value := 5000;
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

-- players.elo_ratings stores what compute_player_elo answered. This file runs
-- whenever it changes, in one transaction, so forgetting the basis here makes
-- the once-a-minute check rebuild every player with the new rule.
DELETE FROM public.player_elo_ratings_basis;
