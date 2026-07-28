-- Who each player queues with. Rows are ordered pairs (both directions), so a
-- profile page filters on steam_id alone rather than OR-ing two columns.
--
-- The join is party_id AND same match, never party_id alone: for 5stack
-- matchmaking party_id is the lobby id, which survives across matches, so
-- joining on it by itself would fuse every match that lobby ever played into
-- one pair. It is also not narrowed to a single lineup, because a lobby that
-- fills the whole match is split across both sides and those players still
-- queued together.
--
-- Deliberately narrower than suggest_player_groups.sql, which joins on
-- match_lineup_id and therefore means "was on the same team as", including
-- the nine strangers a solo queuer gets matched with.
CREATE OR REPLACE VIEW public.v_player_queue_partners AS
 SELECT a.steam_id,
        b.steam_id AS partner_steam_id,
        count(DISTINCT m.id)::int AS matches_together,
        count(DISTINCT m.id) FILTER (
            WHERE m.winning_lineup_id = a.match_lineup_id
        )::int AS wins_together,
        min(m.effective_at) AS first_played_at,
        max(m.effective_at) AS last_played_at
   FROM public.match_lineup_players a
   JOIN public.match_lineups mla
     ON mla.id = a.match_lineup_id
   JOIN public.matches m
     ON m.id = mla.match_id
   JOIN public.match_lineups mlb
     ON mlb.match_id = m.id
   JOIN public.match_lineup_players b
     ON b.match_lineup_id = mlb.id
    AND b.party_id = a.party_id
    AND b.steam_id <> a.steam_id
  WHERE a.party_id IS NOT NULL
    AND a.steam_id IS NOT NULL
    AND b.steam_id IS NOT NULL
    AND m.status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
  GROUP BY a.steam_id, b.steam_id;
