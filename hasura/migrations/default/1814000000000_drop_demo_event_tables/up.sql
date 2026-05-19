CREATE TABLE IF NOT EXISTS public.player_match_map_event_aggregates (
  match_id                   uuid    NOT NULL,
  match_map_id               uuid    NOT NULL,
  round                      integer NOT NULL,
  steam_id                   bigint  NOT NULL,
  shots_fired                integer NOT NULL DEFAULT 0,
  wasted_magazine_shots      integer NOT NULL DEFAULT 0,
  spotted_count              integer NOT NULL DEFAULT 0,
  spotted_with_damage_count  integer NOT NULL DEFAULT 0,
  flash_thrown               integer NOT NULL DEFAULT 0,
  smoke_thrown               integer NOT NULL DEFAULT 0,
  he_thrown                  integer NOT NULL DEFAULT 0,
  molotov_thrown             integer NOT NULL DEFAULT 0,
  decoy_thrown               integer NOT NULL DEFAULT 0,
  CONSTRAINT player_match_map_event_aggregates_pkey
    PRIMARY KEY (match_map_id, round, steam_id),
  CONSTRAINT player_match_map_event_aggregates_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_match_map_event_aggregates_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_match_map_event_aggregates_match_map
  ON public.player_match_map_event_aggregates (match_map_id);

INSERT INTO public.player_match_map_event_aggregates (
  match_id, match_map_id, round, steam_id,
  shots_fired, wasted_magazine_shots,
  spotted_count, spotted_with_damage_count,
  flash_thrown, smoke_thrown, he_thrown, molotov_thrown, decoy_thrown
)
WITH
shots AS (
  SELECT match_id, match_map_id, round, attacker_steam_id AS steam_id,
         COUNT(*)::int AS shots_fired
  FROM public.player_shots_fired
  WHERE attacker_steam_id IS NOT NULL
  GROUP BY match_id, match_map_id, round, attacker_steam_id
),
wasted AS (
  SELECT match_id, match_map_id, round, steam_id,
         SUM(GREATEST(ammo_in_magazine - 1, 0))::int AS wasted_magazine_shots
  FROM (
    SELECT match_id, match_map_id, round,
           attacker_steam_id AS steam_id,
           ammo_in_magazine,
           LEAD(ammo_in_magazine) OVER (
             PARTITION BY match_map_id, attacker_steam_id, round, "with"
             ORDER BY tick
           ) AS next_ammo
    FROM public.player_shots_fired
    WHERE ammo_in_magazine IS NOT NULL
  ) o
  WHERE next_ammo IS NOT NULL AND next_ammo > ammo_in_magazine
  GROUP BY match_id, match_map_id, round, steam_id
),
spotted_counts AS (
  SELECT match_id, match_map_id, round, spotter_steam_id AS steam_id,
         COUNT(*)::int AS spotted_count
  FROM public.player_spotted
  WHERE spotter_steam_id IS NOT NULL
  GROUP BY match_id, match_map_id, round, spotter_steam_id
),
spotted_with_dmg AS (
  SELECT
    ps.match_id, ps.match_map_id, ps.round,
    ps.spotter_steam_id AS steam_id,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM public.player_damages pd
        WHERE pd.match_map_id      = ps.match_map_id
          AND pd.round::integer    = ps.round
          AND pd.attacker_steam_id = ps.spotter_steam_id
          AND pd.attacked_steam_id = ps.spotted_steam_id
          AND pd.attacker_team    <> pd.attacked_team
      )
    )::int AS spotted_with_damage_count
  FROM public.player_spotted ps
  WHERE ps.spotter_steam_id IS NOT NULL
  GROUP BY ps.match_id, ps.match_map_id, ps.round, ps.spotter_steam_id
),
grenades_thrown AS (
  SELECT match_id, match_map_id, round, thrower_steam_id AS steam_id,
         COUNT(*) FILTER (WHERE type = 'Flash')::int   AS flash_thrown,
         COUNT(*) FILTER (WHERE type = 'Smoke')::int   AS smoke_thrown,
         COUNT(*) FILTER (WHERE type = 'HE')::int      AS he_thrown,
         COUNT(*) FILTER (WHERE type = 'Molotov')::int AS molotov_thrown,
         COUNT(*) FILTER (WHERE type = 'Decoy')::int   AS decoy_thrown
  FROM public.player_grenade_throws
  WHERE thrower_steam_id IS NOT NULL AND phase = 'thrown'
  GROUP BY match_id, match_map_id, round, thrower_steam_id
)
SELECT
  COALESCE(s.match_id, w.match_id, sc.match_id, swd.match_id, gt.match_id),
  COALESCE(s.match_map_id, w.match_map_id, sc.match_map_id, swd.match_map_id, gt.match_map_id),
  COALESCE(s.round, w.round, sc.round, swd.round, gt.round),
  COALESCE(s.steam_id, w.steam_id, sc.steam_id, swd.steam_id, gt.steam_id),
  COALESCE(s.shots_fired, 0),
  COALESCE(w.wasted_magazine_shots, 0),
  COALESCE(sc.spotted_count, 0),
  COALESCE(swd.spotted_with_damage_count, 0),
  COALESCE(gt.flash_thrown, 0),
  COALESCE(gt.smoke_thrown, 0),
  COALESCE(gt.he_thrown, 0),
  COALESCE(gt.molotov_thrown, 0),
  COALESCE(gt.decoy_thrown, 0)
FROM shots s
FULL OUTER JOIN wasted w
  ON w.match_map_id = s.match_map_id AND w.round = s.round AND w.steam_id = s.steam_id
FULL OUTER JOIN spotted_counts sc
  ON sc.match_map_id = COALESCE(s.match_map_id, w.match_map_id)
 AND sc.round        = COALESCE(s.round, w.round)
 AND sc.steam_id     = COALESCE(s.steam_id, w.steam_id)
FULL OUTER JOIN spotted_with_dmg swd
  ON swd.match_map_id = COALESCE(s.match_map_id, w.match_map_id, sc.match_map_id)
 AND swd.round        = COALESCE(s.round, w.round, sc.round)
 AND swd.steam_id     = COALESCE(s.steam_id, w.steam_id, sc.steam_id)
FULL OUTER JOIN grenades_thrown gt
  ON gt.match_map_id = COALESCE(s.match_map_id, w.match_map_id, sc.match_map_id, swd.match_map_id)
 AND gt.round        = COALESCE(s.round, w.round, sc.round, swd.round)
 AND gt.steam_id     = COALESCE(s.steam_id, w.steam_id, sc.steam_id, swd.steam_id)
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS public.player_positions;
DROP TABLE IF EXISTS public.player_shots_fired;
DROP TABLE IF EXISTS public.player_spotted;
DROP TABLE IF EXISTS public.player_grenade_throws;
