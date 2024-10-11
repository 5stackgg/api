SET check_function_bodies = false;
CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    short_name text NOT NULL,
    owner_steam_id bigint NOT NULL
);

CREATE TABLE public.matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid,
    label text,
    scheduled_at timestamp with time zone,
    password text DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'PickingPlayers'::text NOT NULL,
    organizer_steam_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    match_options_id uuid,
    winning_lineup_id uuid,
    lineup_1_id uuid NOT NULL,
    lineup_2_id uuid NOT NULL
);

CREATE TABLE public.tournaments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    start timestamp with time zone NOT NULL,
    organizer_steam_id bigint NOT NULL,
    status text DEFAULT 'Setup'::text NOT NULL,
    match_options_id uuid NOT NULL
);

CREATE TABLE public.match_map_veto_picks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    type text NOT NULL,
    match_lineup_id uuid NOT NULL,
    map_id uuid NOT NULL,
    side text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.match_lineup_players (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    steam_id bigint,
    match_lineup_id uuid NOT NULL,
    discord_id text,
    captain boolean DEFAULT false NOT NULL,
    placeholder_name text,
    checked_in boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_null_steam_id_place_holder_name CHECK ((((steam_id IS NOT NULL) AND (placeholder_name IS NULL)) OR ((steam_id IS NULL) AND (placeholder_name IS NOT NULL))))
);
COMMENT ON TABLE public.match_lineup_players IS 'relational table for assigning a players to a match and lineup';

CREATE TABLE public.match_maps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    map_id uuid NOT NULL,
    "order" integer NOT NULL,
    status text DEFAULT 'Scheduled'::text NOT NULL,
    lineup_1_side text DEFAULT 'CT'::text NOT NULL,
    lineup_2_side text DEFAULT 'TERRORIST'::text,
    lineup_1_timeouts_available integer DEFAULT 2 NOT NULL,
    lineup_2_timeouts_available integer DEFAULT 2 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tournament_team_roster (
    tournament_team_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    tournament_id uuid NOT NULL,
    role text DEFAULT 'Member'::text NOT NULL
);

CREATE TABLE public.players (
    steam_id bigint NOT NULL,
    name text NOT NULL,
    profile_url text,
    avatar_url text,
    discord_id text,
    created_at timestamp with time zone DEFAULT now(),
    role text DEFAULT 'user'::text NOT NULL
);

CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    host text NOT NULL,
    label text NOT NULL,
    rcon_password bytea NOT NULL,
    port integer DEFAULT 27015 NOT NULL,
    tv_port integer,
    is_on_demand boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    api_password uuid DEFAULT gen_random_uuid() NOT NULL
);

CREATE TABLE public.match_lineups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    coach_steam_id bigint
);
COMMENT ON TABLE public.match_lineups IS 'relational table for assigning a team to a match and lineup';

CREATE TABLE public.match_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    overtime boolean NOT NULL,
    knife_round boolean NOT NULL,
    mr integer NOT NULL,
    best_of integer NOT NULL,
    coaches boolean NOT NULL,
    number_of_substitutes integer DEFAULT 0 NOT NULL,
    map_veto boolean NOT NULL,
    timeout_setting text DEFAULT 'CoachAndPlayers'::text NOT NULL,
    tech_timeout_setting text DEFAULT 'CoachAndPlayers'::text NOT NULL,
    map_pool_id uuid NOT NULL,
    type text DEFAULT 'competitive'::text NOT NULL
);

CREATE TABLE public.player_damages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    round numeric NOT NULL,
    attacker_steam_id bigint,
    attacker_team text,
    attacker_location text,
    attacked_steam_id bigint NOT NULL,
    attacked_team text NOT NULL,
    attacked_location text NOT NULL,
    "with" text,
    damage integer NOT NULL,
    damage_armor integer NOT NULL,
    health integer NOT NULL,
    armor integer NOT NULL,
    hitgroup text NOT NULL,
    "time" timestamp with time zone NOT NULL,
    attacker_location_coordinates text,
    attacked_location_coordinates text
);

CREATE TABLE public.tournament_brackets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tournament_stage_id uuid NOT NULL,
    match_id uuid,
    tournament_team_id_1 uuid,
    tournament_team_id_2 uuid,
    parent_bracket_id uuid,
    round integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    match_number integer
);

CREATE TABLE public.team_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    steam_id bigint NOT NULL,
    invited_by_player_steam_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public._map_pool (
    map_id uuid NOT NULL,
    map_pool_id uuid NOT NULL
);
CREATE TABLE public.e_map_pool_types (
    value text NOT NULL,
    description text
);
CREATE TABLE public.e_match_map_status (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_match_status (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_match_types (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_objective_types (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_player_roles (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_sides (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_team_roles (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_timeout_settings (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_tournament_stage_types (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_tournament_status (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_utility_types (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.e_veto_pick_types (
    value text NOT NULL,
    description text NOT NULL
);
CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    invite_only boolean NOT NULL,
    owner_steam_id bigint NOT NULL,
    start date NOT NULL,
    "end" date NOT NULL
);
CREATE TABLE public.map_pools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    seed boolean DEFAULT false NOT NULL
);
CREATE TABLE public.maps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    active_pool boolean NOT NULL,
    workshop_map_id text,
    poster text,
    patch text
);
CREATE TABLE public.match_map_demos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file text NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    size integer NOT NULL
);
CREATE TABLE public.match_map_rounds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_map_id uuid NOT NULL,
    round integer NOT NULL,
    lineup_1_score integer NOT NULL,
    lineup_2_score integer NOT NULL,
    lineup_1_money integer NOT NULL,
    lineup_2_money integer NOT NULL,
    "time" timestamp with time zone NOT NULL,
    lineup_1_timeouts_available integer NOT NULL,
    lineup_2_timeouts_available integer NOT NULL,
    backup_file text
);
CREATE TABLE public.player_assists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    "time" timestamp with time zone NOT NULL,
    round integer NOT NULL,
    attacker_steam_id bigint NOT NULL,
    attacker_team text NOT NULL,
    attacked_steam_id bigint NOT NULL,
    attacked_team text NOT NULL,
    flash boolean DEFAULT false NOT NULL
);
CREATE TABLE public.player_flashes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    "time" timestamp with time zone NOT NULL,
    round integer NOT NULL,
    attacker_steam_id bigint NOT NULL,
    attacked_steam_id bigint NOT NULL,
    duration numeric NOT NULL,
    team_flash boolean NOT NULL
);
CREATE TABLE public.player_kills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    round integer NOT NULL,
    attacker_steam_id bigint,
    attacker_team text,
    attacker_location text,
    attacked_steam_id bigint NOT NULL,
    attacked_team text NOT NULL,
    attacked_location text NOT NULL,
    "with" text,
    hitgroup text NOT NULL,
    "time" timestamp with time zone NOT NULL,
    attacker_location_coordinates text,
    attacked_location_coordinates text,
    no_scope boolean DEFAULT false NOT NULL,
    blinded boolean DEFAULT false NOT NULL,
    thru_smoke boolean DEFAULT false NOT NULL,
    headshot boolean DEFAULT false NOT NULL,
    assisted boolean DEFAULT false NOT NULL,
    thru_wall boolean DEFAULT false NOT NULL,
    in_air boolean DEFAULT false NOT NULL
);
CREATE TABLE public.player_objectives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    "time" timestamp with time zone NOT NULL,
    round integer NOT NULL,
    type text NOT NULL
);
CREATE TABLE public.player_unused_utility (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    round integer NOT NULL,
    unused integer NOT NULL
);
CREATE TABLE public.player_utility (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    match_map_id uuid NOT NULL,
    "time" timestamp with time zone NOT NULL,
    round integer NOT NULL,
    type text NOT NULL,
    attacker_steam_id bigint NOT NULL,
    attacker_location_coordinates text
);
CREATE TABLE public.team_roster (
    player_steam_id bigint NOT NULL,
    team_id uuid NOT NULL,
    role text DEFAULT 'Pending'::text NOT NULL
);
CREATE TABLE public.tournament_organizers (
    steam_id bigint NOT NULL,
    tournament_id uuid NOT NULL
);
CREATE TABLE public.tournament_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tournament_id uuid NOT NULL,
    type text NOT NULL,
    "order" integer DEFAULT 1 NOT NULL,
    settings jsonb,
    min_teams integer NOT NULL,
    max_teams integer NOT NULL
);
CREATE TABLE public.tournament_teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    tournament_id uuid NOT NULL,
    name text NOT NULL,
    owner_steam_id bigint NOT NULL,
    eligible_at timestamp with time zone,
    seed integer
);

ALTER TABLE ONLY public.e_map_pool_types
    ADD CONSTRAINT e_map_pool_types_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_match_status
    ADD CONSTRAINT e_match_status_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_match_types
    ADD CONSTRAINT e_match_types_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_objective_types
    ADD CONSTRAINT e_objective__pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_player_roles
    ADD CONSTRAINT e_player_roles_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_team_roles
    ADD CONSTRAINT e_team_roles_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_sides
    ADD CONSTRAINT e_teams_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_timeout_settings
    ADD CONSTRAINT e_timeout_settings_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_tournament_stage_types
    ADD CONSTRAINT e_tournament_stage_types_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_tournament_status
    ADD CONSTRAINT e_tournament_status_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_utility_types
    ADD CONSTRAINT e_utility_types_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_veto_pick_types
    ADD CONSTRAINT e_veto_pick_type_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.events
    ADD CONSTRAINT leagues_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public._map_pool
    ADD CONSTRAINT map_pool_pkey PRIMARY KEY (map_id, map_pool_id);
ALTER TABLE ONLY public.map_pools
    ADD CONSTRAINT map_pools_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.maps
    ADD CONSTRAINT maps_name_type_key UNIQUE (name, type);
ALTER TABLE ONLY public.maps
    ADD CONSTRAINT maps_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_map_demos
    ADD CONSTRAINT match_demos_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_lineup_players
    ADD CONSTRAINT match_lineup_players_match_lineup_id_placeholder_name_key UNIQUE (match_lineup_id, placeholder_name);
ALTER TABLE ONLY public.match_lineup_players
    ADD CONSTRAINT match_lineup_players_match_lineup_id_steam_id_key UNIQUE (match_lineup_id, steam_id);
ALTER TABLE ONLY public.e_match_map_status
    ADD CONSTRAINT match_map_status_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_match_id_order_key UNIQUE (match_id, "order");
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_lineup_players
    ADD CONSTRAINT match_members_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_options
    ADD CONSTRAINT match_options_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_map_rounds
    ADD CONSTRAINT match_rounds__id_key UNIQUE (id);
ALTER TABLE ONLY public.match_map_rounds
    ADD CONSTRAINT match_rounds_match_id_round_key UNIQUE (match_map_id, round);
ALTER TABLE ONLY public.match_map_rounds
    ADD CONSTRAINT match_rounds_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_lineups
    ADD CONSTRAINT match_teams_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.match_map_veto_picks
    ADD CONSTRAINT match_map_veto_picks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_lineup_1_id_key UNIQUE (lineup_1_id);
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_lineup_1_id_lineup_2_id_key UNIQUE (lineup_1_id, lineup_2_id);
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_lineup_2_id_key UNIQUE (lineup_2_id);
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_assists
    ADD CONSTRAINT player_assists_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_damages
    ADD CONSTRAINT player_damages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_flashes
    ADD CONSTRAINT player_flashes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_kills
    ADD CONSTRAINT player_kills_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_objectives
    ADD CONSTRAINT player_objectives_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_unused_utility
    ADD CONSTRAINT player_unused_utility_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_utility
    ADD CONSTRAINT player_utility_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_discord_id_key UNIQUE (discord_id);
ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_pkey PRIMARY KEY (steam_id);
ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_steam_id_key UNIQUE (steam_id);
ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_id_key UNIQUE (id);
ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.team_roster
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (player_steam_id, team_id);
ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_name_key UNIQUE (name);
ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tournament_brackets
    ADD CONSTRAINT touarnment_brackets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tournament_brackets
    ADD CONSTRAINT tournament_brackets_id_tournament_team_id_1_tournament_team_id_ UNIQUE (id, tournament_team_id_1, tournament_team_id_2);
ALTER TABLE ONLY public.tournament_organizers
    ADD CONSTRAINT tournament_organizers_pkey PRIMARY KEY (steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_pkey PRIMARY KEY (player_steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_player_steam_id_tournament_id_key UNIQUE (player_steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_stages
    ADD CONSTRAINT tournament_stages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tournament_teams
    ADD CONSTRAINT tournament_teams_creator_steam_id_tournament_id_key UNIQUE (owner_steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_teams
    ADD CONSTRAINT tournament_teams_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tournament_teams
    ADD CONSTRAINT tournament_teams_tournament_id_team_id_key UNIQUE (tournament_id, team_id);
ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_match_options_id_key UNIQUE (match_options_id);
ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_pkey PRIMARY KEY (id);
CREATE INDEX assists_player_match ON public.player_assists USING btree (attacker_steam_id, match_id);
CREATE INDEX damage_player_match ON public.player_damages USING btree (attacker_steam_id, match_id);
CREATE INDEX deaths_player_match ON public.player_kills USING btree (attacked_steam_id, match_id);
CREATE INDEX demo_match ON public.match_map_demos USING btree (match_id);
CREATE INDEX flashes_player_match ON public.player_flashes USING btree (attacker_steam_id, match_id);
CREATE INDEX kills_player_match ON public.player_kills USING btree (attacker_steam_id, match_id);
CREATE INDEX objectives_player_match ON public.player_objectives USING btree (player_steam_id, match_id);
CREATE INDEX unused_utility_player_match ON public.player_unused_utility USING btree (player_steam_id, match_id);
CREATE INDEX utility_player_match ON public.player_utility USING btree (attacker_steam_id, match_id);
CREATE INDEX veto_match ON public.match_map_veto_picks USING btree (match_id);

ALTER TABLE ONLY public._map_pool
    ADD CONSTRAINT map_pool_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public._map_pool
    ADD CONSTRAINT map_pool_map_pool_id_fkey FOREIGN KEY (map_pool_id) REFERENCES public.map_pools(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.map_pools
    ADD CONSTRAINT map_pools_type_fkey FOREIGN KEY (type) REFERENCES public.e_map_pool_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.maps
    ADD CONSTRAINT maps_type_fkey FOREIGN KEY (type) REFERENCES public.e_match_types(value) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_map_demos
    ADD CONSTRAINT match_demos_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_map_demos
    ADD CONSTRAINT match_demos_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_lineup_players
    ADD CONSTRAINT match_lineup_players_match_lineup_id_fkey FOREIGN KEY (match_lineup_id) REFERENCES public.match_lineups(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_lineups
    ADD CONSTRAINT match_lineups_coach_steam_id_fkey FOREIGN KEY (coach_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_map_rounds
    ADD CONSTRAINT match_map_rounds_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_lineup_1_side_fkey FOREIGN KEY (lineup_1_side) REFERENCES public.e_sides(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_lineup_2_side_fkey FOREIGN KEY (lineup_2_side) REFERENCES public.e_sides(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_maps
    ADD CONSTRAINT match_maps_status_fkey FOREIGN KEY (status) REFERENCES public.e_match_map_status(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_options
    ADD CONSTRAINT match_options_map_pool_id_fkey FOREIGN KEY (map_pool_id) REFERENCES public.map_pools(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_options
    ADD CONSTRAINT match_options_tech_timeout_setting_fkey FOREIGN KEY (tech_timeout_setting) REFERENCES public.e_timeout_settings(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_options
    ADD CONSTRAINT match_options_timeout_setting_fkey FOREIGN KEY (timeout_setting) REFERENCES public.e_timeout_settings(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_options
    ADD CONSTRAINT match_options_type_fkey FOREIGN KEY (type) REFERENCES public.e_match_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_lineup_players
    ADD CONSTRAINT match_team_members_steam_id_fkey FOREIGN KEY (steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_lineups
    ADD CONSTRAINT match_teams_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_map_veto_picks
    ADD CONSTRAINT match_map_veto_picks_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_map_veto_picks
    ADD CONSTRAINT match_map_veto_picks_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_map_veto_picks
    ADD CONSTRAINT match_map_veto_picks_match_lineup_id_fkey FOREIGN KEY (match_lineup_id) REFERENCES public.match_lineups(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_map_veto_picks
    ADD CONSTRAINT match_map_veto_picks_type_fkey FOREIGN KEY (type) REFERENCES public.e_veto_pick_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_lineup_1_id_fkey FOREIGN KEY (lineup_1_id) REFERENCES public.match_lineups(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_lineup_2_id_fkey FOREIGN KEY (lineup_2_id) REFERENCES public.match_lineups(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_match_options_id_fkey FOREIGN KEY (match_options_id) REFERENCES public.match_options(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_status_fkey FOREIGN KEY (status) REFERENCES public.e_match_status(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.player_assists
    ADD CONSTRAINT player_assists_attacked_player_steam_id_fkey FOREIGN KEY (attacked_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_assists
    ADD CONSTRAINT player_assists_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_assists
    ADD CONSTRAINT player_assists_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_assists
    ADD CONSTRAINT player_assists_player_steam_id_fkey FOREIGN KEY (attacker_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_damages
    ADD CONSTRAINT player_damages_attacked_player_steam_id_fkey FOREIGN KEY (attacked_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_damages
    ADD CONSTRAINT player_damages_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_damages
    ADD CONSTRAINT player_damages_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_damages
    ADD CONSTRAINT player_damages_player_steam_id_fkey FOREIGN KEY (attacker_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_flashes
    ADD CONSTRAINT player_flashes_attacked_steam_id_fkey FOREIGN KEY (attacked_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_flashes
    ADD CONSTRAINT player_flashes_attacker_steam_id_fkey FOREIGN KEY (attacker_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_flashes
    ADD CONSTRAINT player_flashes_mach_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_flashes
    ADD CONSTRAINT player_flashes_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_kills
    ADD CONSTRAINT player_kills_attacked_player_steam_id_fkey FOREIGN KEY (attacked_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_kills
    ADD CONSTRAINT player_kills_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_kills
    ADD CONSTRAINT player_kills_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_kills
    ADD CONSTRAINT player_kills_player_steam_id_fkey FOREIGN KEY (attacker_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_objectives
    ADD CONSTRAINT player_objectives_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_objectives
    ADD CONSTRAINT player_objectives_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_objectives
    ADD CONSTRAINT player_objectives_player_steam_id_fkey FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_objectives
    ADD CONSTRAINT player_objectives_type_fkey FOREIGN KEY (type) REFERENCES public.e_objective_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.player_unused_utility
    ADD CONSTRAINT player_unused_utility_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_unused_utility
    ADD CONSTRAINT player_unused_utility_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_unused_utility
    ADD CONSTRAINT player_unused_utility_player_steam_id_fkey FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_utility
    ADD CONSTRAINT player_utility_attacker_steam_id_fkey FOREIGN KEY (attacker_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_utility
    ADD CONSTRAINT player_utility_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_utility
    ADD CONSTRAINT player_utility_match_map_id_fkey FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.player_utility
    ADD CONSTRAINT player_utility_type_fkey FOREIGN KEY (type) REFERENCES public.e_utility_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_role_fkey FOREIGN KEY (role) REFERENCES public.e_player_roles(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_invited_by_player_steam_id_fkey FOREIGN KEY (invited_by_player_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_steam_id_fkey FOREIGN KEY (steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.team_roster
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.team_roster
    ADD CONSTRAINT team_members_user_steam_id_fkey FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.team_roster
    ADD CONSTRAINT team_roster_role_fkey FOREIGN KEY (role) REFERENCES public.e_team_roles(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_owner_steam_id_fkey FOREIGN KEY (owner_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournament_brackets
    ADD CONSTRAINT tournament_brackets_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournament_brackets
    ADD CONSTRAINT tournament_brackets_tournament_stage_id_fkey FOREIGN KEY (tournament_stage_id) REFERENCES public.tournament_stages(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_brackets
    ADD CONSTRAINT tournament_brackets_tournament_team_id_1_fkey FOREIGN KEY (tournament_team_id_1) REFERENCES public.tournament_teams(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.tournament_brackets
    ADD CONSTRAINT tournament_brackets_tournament_team_id_2_fkey FOREIGN KEY (tournament_team_id_2) REFERENCES public.tournament_teams(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY public.tournament_organizers
    ADD CONSTRAINT tournament_organizers_steam_id_fkey FOREIGN KEY (steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournament_organizers
    ADD CONSTRAINT tournament_organizers_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_player_steam_id_fkey FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_tournament_team_id_fkey FOREIGN KEY (tournament_team_id) REFERENCES public.tournament_teams(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_stages
    ADD CONSTRAINT tournament_stages_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_stages
    ADD CONSTRAINT tournament_stages_type_fkey FOREIGN KEY (type) REFERENCES public.e_tournament_stage_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_team_roster_role_fkey FOREIGN KEY (role) REFERENCES public.e_team_roles(value) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournament_teams
    ADD CONSTRAINT tournament_teams_creator_steam_id_fkey FOREIGN KEY (owner_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournament_teams
    ADD CONSTRAINT tournament_teams_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_teams
    ADD CONSTRAINT tournament_teams_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_match_options_id_fkey FOREIGN KEY (match_options_id) REFERENCES public.match_options(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_organizer_steam_id_fkey FOREIGN KEY (organizer_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.tournaments
    ADD CONSTRAINT tournaments_status_fkey FOREIGN KEY (status) REFERENCES public.e_tournament_status(value) ON UPDATE CASCADE ON DELETE RESTRICT;
