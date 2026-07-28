-- Ordered pairs (both directions) so a profile filters on steam_id alone.
--
-- Joined on party_id AND same match, never party_id alone: a 5stack party_id is
-- the lobby id and survives across matches, so party_id by itself would fuse
-- every match that lobby ever played into one pair. Not narrowed to a single
-- lineup either — a lobby that fills the whole match is split across both.
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
