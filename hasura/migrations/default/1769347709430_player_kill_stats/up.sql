CREATE TABLE IF NOT EXISTS player_kills_by_weapon (
  player_steam_id bigint NOT NULL,
  "with" text NOT NULL,
  kill_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (player_steam_id, "with")
);

alter table "public"."player_stats"
  add constraint "player_stats_player_steam_id_fkey"
  foreign key ("player_steam_id")
  references "public"."players"
  ("steam_id") on update cascade on delete cascade;


INSERT INTO player_kills_by_weapon (player_steam_id, "with", kill_count)
SELECT
  attacker_steam_id AS player_steam_id,
  "with",
  COUNT(*) AS kill_count
FROM player_kills
GROUP BY attacker_steam_id, "with"
ON CONFLICT (player_steam_id, "with")
DO UPDATE SET kill_count = EXCLUDED.kill_count;

CREATE TABLE IF NOT EXISTS player_stats (
  player_steam_id bigint NOT NULL,
  kills bigint NOT NULL DEFAULT 0,
  deaths bigint NOT NULL DEFAULT 0,
  assists bigint NOT NULL DEFAULT 0,
  headshots bigint NOT NULL DEFAULT 0,
  headshot_percentage float NOT NULL DEFAULT 0,
  PRIMARY KEY (player_steam_id)
);

alter table "public"."player_kills_by_weapon"
  add constraint "player_kills_by_weapon_player_steam_id_fkey"
  foreign key ("player_steam_id")
  references "public"."players"
  ("steam_id") on update cascade on delete cascade;

INSERT INTO player_stats (
  player_steam_id,
  kills,
  deaths,
  assists,
  headshots,
  headshot_percentage
)
WITH players AS (
  SELECT attacker_steam_id AS player_steam_id FROM player_kills
  UNION
  SELECT attacked_steam_id FROM player_kills
  UNION
  SELECT attacker_steam_id FROM player_assists
)
SELECT
  p.player_steam_id,

  -- kills
  COALESCE(k.kills, 0) AS kills,

  -- deaths
  COALESCE(d.deaths, 0) AS deaths,

  -- assists
  COALESCE(a.assists, 0) AS assists,

  -- headshots
  COALESCE(h.headshots, 0) AS headshots,

  -- headshot %
  CASE
    WHEN COALESCE(k.kills, 0) = 0 THEN 0
    ELSE COALESCE(h.headshots, 0)::float / k.kills
  END AS headshot_percentage

FROM players p

LEFT JOIN (
  SELECT attacker_steam_id, COUNT(*) AS kills
  FROM player_kills
  GROUP BY attacker_steam_id
) k ON k.attacker_steam_id = p.player_steam_id

LEFT JOIN (
  SELECT attacked_steam_id, COUNT(*) AS deaths
  FROM player_kills
  GROUP BY attacked_steam_id
) d ON d.attacked_steam_id = p.player_steam_id

LEFT JOIN (
  SELECT attacker_steam_id, COUNT(*) AS assists
  FROM player_assists
  GROUP BY attacker_steam_id
) a ON a.attacker_steam_id = p.player_steam_id

LEFT JOIN (
  SELECT attacker_steam_id, COUNT(*) AS headshots
  FROM player_kills
  WHERE headshot = true
  GROUP BY attacker_steam_id
) h ON h.attacker_steam_id = p.player_steam_id

ON CONFLICT (player_steam_id)
DO UPDATE SET
  kills = EXCLUDED.kills,
  deaths = EXCLUDED.deaths,
  assists = EXCLUDED.assists,
  headshots = EXCLUDED.headshots,
  headshot_percentage = EXCLUDED.headshot_percentage;
