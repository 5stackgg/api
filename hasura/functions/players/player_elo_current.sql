-- Rebuilds these players' player_elo_current rows (migration 1890000001240)
-- from their unvoided player_elo rows: the latest rating per type over all of
-- them, per season, and over season-less tournament matches.
CREATE OR REPLACE FUNCTION public.refresh_player_elo_current(_steam_ids bigint[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF cardinality(_steam_ids) = 0 THEN
        RETURN;
    END IF;

    -- Taking each player's lifetime row first queues this behind a refresh of
    -- the same player that has not committed yet, so the reads below see its
    -- rows.
    INSERT INTO public.player_elo_current (steam_id, ladder)
    SELECT p.steam_id, 'lifetime'
    FROM public.players p
    WHERE p.steam_id = ANY (_steam_ids)
    ORDER BY p.steam_id
    ON CONFLICT (steam_id, ladder, season_id) DO UPDATE SET steam_id = EXCLUDED.steam_id;

    DELETE FROM public.player_elo_current WHERE steam_id = ANY (_steam_ids);

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
    WHERE pe.steam_id = ANY (_steam_ids)
      AND NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.id = pe.match_id AND m.elo_voided)
      AND CASE l.ladder
              WHEN 'lifetime' THEN true
              WHEN 'season' THEN pe.season_id IS NOT NULL
              ELSE pe.season_id IS NULL AND pe.is_tournament
          END
    GROUP BY pe.steam_id, l.ladder, l.season_id;
END;
$$;
