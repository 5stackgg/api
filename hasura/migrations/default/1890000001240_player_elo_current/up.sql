-- players.elo shows each player's latest unvoided rating per type on three
-- ladders: lifetime, the active season and tournaments. Finding those meant a
-- dozen lookups and nested function calls per player, paid for every player on
-- a team page, lobby, friends list or match lineup. This table keeps them, one
-- row per ladder (and per season), and hasura/triggers/player_elo_current.sql
-- rebuilds a player's rows whenever their player_elo rows change.
CREATE TABLE IF NOT EXISTS public.player_elo_current (
    steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    ladder text NOT NULL CHECK (ladder IN ('lifetime', 'season', 'tournament')),
    season_id uuid,
    competitive numeric,
    wingman numeric,
    duel numeric,
    rush numeric,
    CHECK ((ladder = 'season') = (season_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS player_elo_current_key
    ON public.player_elo_current (steam_id, ladder, season_id) NULLS NOT DISTINCT;

INSERT INTO public.player_elo_current (steam_id, ladder, season_id, competitive, wingman, duel, rush)
SELECT pe.steam_id, l.ladder, l.season_id,
       (array_agg(pe."current" ORDER BY pe.created_at DESC) FILTER (WHERE pe."type" = 'Competitive'))[1],
       (array_agg(pe."current" ORDER BY pe.created_at DESC) FILTER (WHERE pe."type" = 'Wingman'))[1],
       (array_agg(pe."current" ORDER BY pe.created_at DESC) FILTER (WHERE pe."type" = 'Duel'))[1],
       (array_agg(pe."current" ORDER BY pe.created_at DESC) FILTER (WHERE pe."type" = 'Rush'))[1]
FROM public.player_elo pe
CROSS JOIN LATERAL (
    VALUES ('lifetime', NULL::uuid), ('season', pe.season_id), ('tournament', NULL::uuid)
) l(ladder, season_id)
WHERE NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.id = pe.match_id AND m.elo_voided)
  AND CASE l.ladder
          WHEN 'lifetime' THEN true
          WHEN 'season' THEN pe.season_id IS NOT NULL
          ELSE pe.season_id IS NULL AND pe.is_tournament
      END
GROUP BY pe.steam_id, l.ladder, l.season_id
ON CONFLICT DO NOTHING;
