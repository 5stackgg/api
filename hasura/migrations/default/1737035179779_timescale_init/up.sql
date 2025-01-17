-- player_damages

ALTER TABLE "public"."player_damages" DROP CONSTRAINT IF EXISTS "player_damages_pkey";
ALTER TABLE "public"."player_damages" ADD PRIMARY KEY ("id", "time", "match_id", "match_map_id");

SELECT create_hypertable('player_damages', 'time', migrate_data => true);

-- player_assists

ALTER TABLE "public"."player_assists" DROP CONSTRAINT IF EXISTS "player_assists_pkey";
ALTER TABLE "public"."player_assists" ADD PRIMARY KEY ("id", "time", "match_id", "match_map_id");

SELECT create_hypertable('player_assists', 'time', migrate_data => true);

-- player_flashes

ALTER TABLE "public"."player_flashes" DROP CONSTRAINT IF EXISTS "player_flashes_pkey";
ALTER TABLE "public"."player_flashes" ADD PRIMARY KEY ("id", "time", "match_id", "match_map_id");

SELECT create_hypertable('player_flashes', 'time', migrate_data => true);

-- player_kills

ALTER TABLE "public"."player_kills" DROP CONSTRAINT IF EXISTS "player_kills_pkey";
ALTER TABLE "public"."player_kills" ADD PRIMARY KEY ("id", "time", "match_id", "match_map_id");

SELECT create_hypertable('player_kills', 'time', migrate_data => true);

-- player_objectives


ALTER TABLE "public"."player_objectives" DROP CONSTRAINT IF EXISTS "player_objectives_pkey";
ALTER TABLE "public"."player_objectives" ADD PRIMARY KEY ("id", "time", "match_id", "match_map_id");

SELECT create_hypertable('player_objectives', 'time', migrate_data => true);

-- player_utility

ALTER TABLE "public"."player_utility" DROP CONSTRAINT IF EXISTS "player_utility_pkey";
ALTER TABLE "public"."player_utility" ADD PRIMARY KEY ("id", "time", "match_id", "match_map_id");

SELECT create_hypertable('player_utility', 'time', migrate_data => true);


-- player_sanctions

ALTER TABLE "public"."player_sanctions" DROP CONSTRAINT IF EXISTS "player_sanctions_pkey";
ALTER TABLE "public"."player_sanctions" ADD PRIMARY KEY ("id", "created_at");

SELECT create_hypertable('player_sanctions', 'created_at', migrate_data => true);
