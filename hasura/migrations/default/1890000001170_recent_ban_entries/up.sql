-- Type-definition table for recently_banned_players(): one row per player
-- banned recently on Steam or here. Never written to directly; only used as
-- the SETOF return type, like leaderboard_entries.
CREATE TABLE IF NOT EXISTS public.recent_ban_entries (
    steam_id bigint NOT NULL,
    banned_at timestamptz NOT NULL,
    banned_at_source text NOT NULL,
    steam_banned_on date,
    vac_ban_count integer NOT NULL DEFAULT 0,
    game_ban_count integer NOT NULL DEFAULT 0,
    sanction_id uuid,
    sanction_kind text,
    banned_here boolean NOT NULL DEFAULT false,
    first_match_at timestamptz,
    last_match_at timestamptz,
    last_match_map text,
    matches_played integer NOT NULL DEFAULT 0,
    matches_since_steam_ban integer,
    arrived_banned boolean NOT NULL DEFAULT false,
    shared_matches jsonb
);

-- The few players Steam has banned, so the list never scans every player.
CREATE INDEX IF NOT EXISTS idx_players_steam_banned
    ON public.players (steam_id)
    WHERE vac_ban_count > 0 OR game_ban_count > 0;
