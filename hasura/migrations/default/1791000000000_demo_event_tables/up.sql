-- Demo-parser output tables. Populated post-hoc by the demo ingestion
-- pipeline (live GSI never writes here). Append-only; mirror the
-- player_damages pattern (uuid PK, FK to match_maps with CASCADE).

CREATE TABLE IF NOT EXISTS public.player_shots_fired (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  match_id          uuid NOT NULL,
  match_map_id      uuid NOT NULL,
  round             integer NOT NULL,
  tick              integer NOT NULL,
  attacker_steam_id bigint NOT NULL,
  attacker_team     text,
  "with"            text,
  CONSTRAINT player_shots_fired_pkey PRIMARY KEY (id),
  CONSTRAINT player_shots_fired_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_shots_fired_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_player_shots_fired_mm_round
  ON public.player_shots_fired (match_map_id, round);
CREATE INDEX IF NOT EXISTS idx_player_shots_fired_mm_attacker
  ON public.player_shots_fired (match_map_id, attacker_steam_id);

CREATE TABLE IF NOT EXISTS public.player_spotted (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  match_id          uuid NOT NULL,
  match_map_id      uuid NOT NULL,
  round             integer NOT NULL,
  tick              integer NOT NULL,
  spotter_steam_id  bigint NOT NULL,
  spotted_steam_id  bigint NOT NULL,
  spotter_team      text,
  CONSTRAINT player_spotted_pkey PRIMARY KEY (id),
  CONSTRAINT player_spotted_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_spotted_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_player_spotted_mm_round
  ON public.player_spotted (match_map_id, round);
CREATE INDEX IF NOT EXISTS idx_player_spotted_mm_spotter
  ON public.player_spotted (match_map_id, spotter_steam_id);

-- Both throws (origin x/y/z) and detonations (x/y/z) into one table; row
-- type is distinguished by `phase`: 'thrown' | 'detonated'. Lets us answer
-- "who threw the molly that detonated at tick N" with a single LAG()-style
-- query within (round, type) — useful because FireGrenadeStart has nil
-- thrower in CS2 demos, so we attribute by joining back to the prior throw.
CREATE TABLE IF NOT EXISTS public.player_grenade_throws (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  match_id          uuid NOT NULL,
  match_map_id      uuid NOT NULL,
  round             integer NOT NULL,
  tick              integer NOT NULL,
  thrower_steam_id  bigint,
  thrower_team      text,
  type              text NOT NULL,
  phase             text NOT NULL,
  x                 numeric,
  y                 numeric,
  z                 numeric,
  CONSTRAINT player_grenade_throws_pkey PRIMARY KEY (id),
  CONSTRAINT player_grenade_throws_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_grenade_throws_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE,
  CONSTRAINT player_grenade_throws_type_chk
    CHECK (type IN ('Flash', 'HE', 'Smoke', 'Molotov', 'Decoy')),
  CONSTRAINT player_grenade_throws_phase_chk
    CHECK (phase IN ('thrown', 'detonated'))
);
CREATE INDEX IF NOT EXISTS idx_player_grenade_throws_mm_round
  ON public.player_grenade_throws (match_map_id, round);
CREATE INDEX IF NOT EXISTS idx_player_grenade_throws_mm_thrower
  ON public.player_grenade_throws (match_map_id, thrower_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_grenade_throws_mm_type_phase
  ON public.player_grenade_throws (match_map_id, type, phase);
