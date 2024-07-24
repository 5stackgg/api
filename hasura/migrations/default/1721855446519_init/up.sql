SET check_function_bodies = false;
CREATE FUNCTION public.add_owner_to_team() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO team_roster (team_id, role, player_steam_id)
    VALUES (NEW.id, 'Admin', NEW.owner_steam_id);
	RETURN NEW;
END;
$$;
CREATE TABLE public.tournaments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    start timestamp with time zone NOT NULL,
    organizer_steam_id bigint NOT NULL,
    status text DEFAULT 'Setup'::text NOT NULL,
    match_options_id uuid NOT NULL
);
CREATE FUNCTION public.can_join_tournament(tournament public.tournaments, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    on_roster boolean;    
BEGIN
	IF tournament.status = 'Setup' THEN
		return false;	
	END IF;
    SELECT EXISTS (
        SELECT 1
        FROM tournament_team_roster ttr
        WHERE
         tournament_id = tournament.id 
         AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) INTO on_roster;
    RETURN NOT on_roster;
END;
$$;
CREATE FUNCTION public.can_pick_veto() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id uuid;
    _match_lineup_id uuid;
    pickType VARCHAR(255);
    lineup_id uuid;
    _match matches;
    map_pool uuid[];
    use_active_pool BOOLEAN;
BEGIN
    -- TOOD - https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban
    -- Get match_id and match_lineup_id from NEW or OLD depending on their availability
    _match_id := COALESCE(NEW.match_id, OLD.match_id);
    _match_lineup_id := COALESCE(NEW.match_lineup_id, OLD.match_lineup_id);
    select * into _match from matches where id = _match_id;
    -- Get map pool for the match
    pickType := get_veto_type(_match);
    -- Check if the pickType matches the type of the new veto
    IF NEW.type != pickType THEN
        RAISE EXCEPTION 'Expected pick type of %', pickType USING ERRCODE = '22000';
    END IF;
    -- Get the lineup_id for the match
    SELECT * INTO lineup_id FROM get_veto_picking_lineup_id(_match); 
    -- Check if the lineup_id matches the lineup_id provided in the new veto
    IF _match_lineup_id != lineup_id THEN
        RAISE EXCEPTION 'Expected other lineup for %', pickType USING ERRCODE = '22000';
    END IF;
    -- Ensure that a side is picked for 'Side' type veto
    IF pickType = 'Side' AND NEW.side IS NULL THEN
        RAISE EXCEPTION 'Must pick a side' USING ERRCODE = '22000';
    END IF;
    -- Ensure that a side is not picked for 'Pick' or 'Ban' type veto
    IF pickType = 'Pick' OR pickType = 'Ban' THEN
        IF NEW.side IS NOT NULL THEN 
            RAISE EXCEPTION 'Cannot % and choose side', pickType USING ERRCODE = '22000';
        END IF;
    END IF;
    -- Check if the map being picked is available for the match
    IF NOT EXISTS (
        SELECT 1 FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        INNER JOIN maps ON maps.id = mp.map_id      
        WHERE maps.id = NEW.map_id AND m.id = _match_id
    ) THEN
        RAISE EXCEPTION 'Map not available for picking' USING ERRCODE = '22000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.check_match_lineup_players_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    lineup_count INTEGER;
    max_players INTEGER;
   match_type VARCHAR(255);
	substitutes INTEGER;
BEGIN
    SELECT mo.type, mo.number_of_substitutes INTO match_type, substitutes 
    FROM matches m
    INNER JOIN match_options mo on mo.id = m.match_options_id
    inner join match_lineups ml on ml.match_id = m.id
    WHERE ml.id = NEW.match_lineup_id;
    max_players := 5;
    IF match_type = 'Wingman' THEN
        max_players := 2;
    END IF;
  	max_players := max_players + substitutes;
    SELECT COUNT(*) INTO lineup_count
    FROM match_lineup_players
    WHERE match_lineup_id = NEW.match_lineup_id;
    IF lineup_count >= max_players THEN
		RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Max number of players reached';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.check_max_match_lineups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (SELECT count(*) FROM match_lineups WHERE match_id = NEW.match_id) >= 2 THEN
    	RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Match cannot have more than two lineups';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.check_team_eligibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    roster_count INT;
    tournament_type TEXT;
    min_players INT;
BEGIN
    SELECT COUNT(ttr.*) INTO roster_count
    FROM tournament_teams tt
    INNER JOIN tournament_team_roster ttr ON ttr.tournament_team_id = tt.id
    WHERE tt.id = NEW.tournament_team_id
    GROUP BY tt.tournament_id
    LIMIT 1;
    SELECT mo.type INTO tournament_type FROM tournaments t
        inner join match_options mo on mo.id = t.match_options_id  
        WHERE t.id = NEW.tournament_id;
    min_players := CASE
                   WHEN tournament_type = 'Wingman' THEN 2
                      ELSE 5
                   END;
    IF roster_count < min_players THEN
    	UPDATE tournament_teams
		    SET eligible_at = null
		    WHERE id = NEW.tournament_team_id;
        RETURN NEW;
    END IF;
    UPDATE tournament_teams
    SET eligible_at = NOW()
    WHERE id = NEW.tournament_team_id;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.create_match_map_from_veto() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  lineup_1_id uuid;
  lineup_2_id uuid;
  total_maps int;
  other_side text;
  available_maps uuid[];
  lineup_id uuid;
  _match matches;
BEGIN
  -- Check if the veto type is 'Side'
  IF NEW.type = 'Side' THEN
        -- Retrieve lineup IDs for the match
        SELECT get_match_lineup_1_id(m.*) INTO lineup_1_id
        FROM matches m
        WHERE m.id = NEW.match_id
        LIMIT 1;
        SELECT get_match_lineup_2_id(m.*) INTO lineup_2_id
        FROM matches m
        WHERE m.id = NEW.match_id
        LIMIT 1;
        -- Count the total number of maps for the match
        SELECT count(*) INTO total_maps FROM match_maps WHERE match_id = NEW.match_id;
        -- Determine the side for each lineup based on the vetoed side
        other_side := CASE WHEN NEW.side = 'CT' THEN 'TERRORIST' ELSE 'CT' END;
        -- Insert the vetoed map into match_maps table
        INSERT INTO match_maps (match_id, map_id, "order", lineup_1_side, lineup_2_side)
            VALUES (NEW.match_id, NEW.map_id, total_maps + 1,
                    CASE WHEN lineup_1_id = NEW.match_lineup_id THEN NEW.side ELSE other_side END,
                    CASE WHEN lineup_2_id = NEW.match_lineup_id THEN NEW.side ELSE other_side END);
   END IF;
  -- Retrieve available maps for veto
  SELECT array_agg(mp.map_id) INTO available_maps
  FROM matches m
  INNER JOIN match_options mo on mo.id = m.match_options_id
  LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
  LEFT JOIN match_veto_picks mvp ON mvp.match_id = NEW.match_id AND mvp.map_id = mp.map_id
  WHERE m.id = NEW.match_id
  AND mvp IS NULL;
  -- If only one map is available for veto
  IF array_length(available_maps, 1) = 1 THEN
    -- Retrieve the match details
    SELECT * INTO _match FROM matches WHERE id = NEW.match_id LIMIT 1;
    -- Determine the lineup ID for veto picking
    SELECT * INTO lineup_id FROM get_veto_picking_lineup_id(_match);
    -- Insert the leftover map into match_veto_picks table
    INSERT INTO match_veto_picks (match_id, type, match_lineup_id, map_id)
    VALUES (NEW.match_id, 'Decider', lineup_id, available_maps[1]);
    -- Update the total number of maps for the match and insert the leftover map into match_maps
    SELECT count(*) INTO total_maps FROM match_maps WHERE match_id = NEW.match_id;
    INSERT INTO match_maps (match_id, map_id, "order")
    VALUES (NEW.match_id, available_maps[1], total_maps + 1);
 	UPDATE matches
    SET status = 'Live'
    WHERE id = NEW.match_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.enforce_max_damage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.damage > 100 THEN
        NEW.damage = 100;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TABLE public.matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid,
    label text,
    scheduled_at date,
    password text DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'PickingPlayers'::text NOT NULL,
    organizer_steam_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    match_options_id uuid
);
CREATE FUNCTION public.get_current_match_map(match public.matches) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_map_id uuid;    
BEGIN
    SELECT mm.id INTO match_map_id 
    FROM match_maps mm
    WHERE mm.match_id = match.id
     and mm.status != 'Finished'
    ORDER BY mm.order ASC
    LIMIT 1;
    RETURN match_map_id;
END;
$$;
CREATE FUNCTION public.get_match_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
    server_port int;
BEGIN
    SELECT
	 m.password INTO password
    FROM matches m
    INNER JOIN match_lineups ml on ml.match_id = m.id
    INNER JOIN match_lineup_players mlp on mlp.match_lineup_id = ml.id
    WHERE m.id = match.id AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
	 IF password IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT s.host, s.port
    INTO server_host, server_port
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    WHERE m.id = match.id
    LIMIT 1;
    connection_string := CONCAT('steam://connect/', server_host, ':', server_port, ';password/', password);
    RETURN CONCAT('/quick-connect?link=', connection_string);
END;
$$;
CREATE FUNCTION public.get_match_connection_string(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
    server_port int;
BEGIN
    SELECT m.password
    INTO password
    FROM matches m
INNER JOIN match_lineups ml on ml.match_id = m.id
    INNER JOIN match_lineup_players mlp on mlp.match_lineup_id = ml.id
    WHERE m.id = match.id AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
	 IF password IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT s.host, s.port
    INTO server_host, server_port
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    WHERE m.id = match.id
    LIMIT 1;
 IF server_host IS NULL THEN
        RETURN NULL;
    END IF;
    connection_string := CONCAT('connect ', server_host, ':', server_port, '; password ', password);
    RETURN connection_string;
END;
$$;
CREATE FUNCTION public.get_match_lineup_1_id(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    lineup_id uuid;
BEGIN
    SELECT ml.id
    INTO lineup_id
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    WHERE m.id = match.id
    order by id desc
    LIMIT 1;
	return lineup_id;
END;
$$;
CREATE FUNCTION public.get_match_lineup_2_id(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    lineup_id uuid;
BEGIN
    SELECT ml.id
    INTO lineup_id
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    WHERE m.id = match.id
    order by id asc
    LIMIT 1;
	return lineup_id;
END;
$$;
CREATE FUNCTION public.get_match_server(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
BEGIN
    SELECT m.password into password
    FROM matches m
    	INNER JOIN match_lineups ml on ml.match_id = m.id
    	INNER JOIN match_lineup_players mlp on mlp.match_lineup_id = ml.id
		INNER JOIN server s on s.id = m.server_id
    WHERE 
    	m.id = match.id 
    	AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
	return password;
END;
$$;
CREATE FUNCTION public.get_match_server_type(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    is_on_demand BOOL;
BEGIN
    IF match.server_id = null THEN
        return '';
    END IF;
	select on_demand into is_on_demand from servers where id = match.server_id;
	IF is_on_demand = true THEN
	    return 'OnDemand';
	END IF;
	return 'Dedicated';
END
$$;
CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    short_name text NOT NULL,
    owner_steam_id bigint NOT NULL
);
CREATE FUNCTION public.get_match_teams(match public.matches) RETURNS SETOF public.teams
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY 
    SELECT DISTINCT t.*
    FROM public.matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    INNER JOIN teams t ON t.id = ml.team_id
    WHERE ml.team_id IS NOT NULL
    and m.id = match.id;
END;
$$;
CREATE FUNCTION public.get_match_tv_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
	tv_port int;
BEGIN
    SELECT s.host, s.tv_port
    INTO server_host, tv_port
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    WHERE m.id = match.id
    LIMIT 1;
    connection_string := CONCAT('steam://connect/', server_host, ':', tv_port);
    RETURN CONCAT('/quick-connect?link=', connection_string);
END;
$$;
CREATE FUNCTION public.get_match_tv_connection_string(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
    tv_port int;
BEGIN
    SELECT s.host, s.tv_port
    INTO server_host, tv_port
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    WHERE m.id = match.id
    LIMIT 1;
 IF server_host IS NULL THEN
        RETURN NULL;
    END IF;
    connection_string := CONCAT('connect ', server_host, ':', tv_port);
    RETURN connection_string;
END;
$$;
CREATE TABLE public.players (
    steam_id bigint NOT NULL,
    name text NOT NULL,
    profile_url text,
    avatar_url text,
    discord_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE FUNCTION public.get_player_matches(player public.players) RETURNS SETOF public.matches
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
        SELECT m.*
        FROM players p
        INNER JOIN match_lineup_players mlp ON mlp.steam_id = p.steam_id
        INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        INNER JOIN matches m ON m.id = ml.match_id
        WHERE p.steam_id = player.steam_id;
END;
$$;
CREATE FUNCTION public.get_player_teams(player public.players) RETURNS SETOF public.teams
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
       SELECT DISTINCT t.*
        FROM players p
        LEFT JOIN team_roster tr on tr.player_steam_id = p.steam_id
        INNER JOIN teams t ON t.id = tr.team_id or t.owner_steam_id = player.steam_id
        where p.steam_id = player.steam_id;
END;
$$;
CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    host text NOT NULL,
    label text NOT NULL,
    rcon_password bytea NOT NULL,
    port integer DEFAULT 27015 NOT NULL,
    tv_port integer,
    on_demand boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    owner_steam_id bigint,
    api_password uuid DEFAULT gen_random_uuid() NOT NULL
);
CREATE FUNCTION public.get_server_current_match_id(server public.servers) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_id text;
BEGIN
    SELECT m.id
    INTO match_id
    FROM servers s
    INNER JOIN matches m ON m.server_id = s.id
    WHERE s.id = server.id
    ORDER BY m.id DESC
    LIMIT 1;
    RETURN match_id;
END;
$$;
CREATE FUNCTION public.get_team_matches(team public.teams) RETURNS SETOF public.matches
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
    SELECT DISTINCT m.*
       FROM teams t
       INNER JOIN match_lineups ml on ml.team_id = t.id
       INNER JOIN matches m ON m.id = ml.match_id
       where t.id = team.id;
END;
$$;
CREATE TABLE public.match_lineups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    match_id uuid NOT NULL,
    coach_steam_id bigint
);
COMMENT ON TABLE public.match_lineups IS 'relational table for assigning a team to a match and lineup';
CREATE FUNCTION public.get_team_name(match_lineup public.match_lineups) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    team_name TEXT;
    lineup_id_1 uuid;
BEGIN
    SELECT t.name INTO team_name
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id 
    LEFT JOIN teams t ON t.id = ml.team_id
    WHERE ml.match_id = match_lineup.match_id AND ml.team_id = match_lineup.team_id;
    -- If team ids match, return the team name
    IF team_name IS NOT NULL THEN
        RETURN team_name;
    END IF;
    -- If team ids do not match, look for captain's name or placeholder_name
    SELECT COALESCE(NULLIF(p.name, ''), mlp.placeholder_name) INTO team_name
    FROM match_lineup_players mlp
    LEFT JOIN players p ON p.steam_id = mlp.steam_id
    WHERE mlp.match_lineup_id = match_lineup.id AND mlp.captain = true
    LIMIT 1;
    -- If captain's name or placeholder_name is found, return it
    IF team_name IS NOT NULL THEN
        RETURN concat('Team ', team_name);
    END IF;
    -- If no captain, detect if it's a lineup 1 or 2 and display it as Team 1 or Team 2
    SELECT get_match_lineup_1_id(m.*) INTO lineup_id_1
    FROM matches m 
    WHERE m.id = match_lineup.match_id 
    LIMIT 1;
    IF match_lineup.id = lineup_id_1 THEN 
        RETURN 'Team 1';
    ELSE 
        RETURN 'Team 2';
    END IF;
END;
$$;
CREATE FUNCTION public.get_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    pool uuid[];
	best_of int;
    pattern TEXT[] := '{}';
    base_pattern TEXT[] := ARRAY['Ban', 'Ban', 'Pick', 'Pick'];
    picks_count INT;
    picks_left INT;
    pattern_length INT;
    i INT;
BEGIN
	SELECT mo.best_of INTO best_of
        FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id;
    SELECT array_agg(mp.map_id) INTO pool
        FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        LEFT JOIN match_veto_picks mvp ON mvp.match_id = _match.id AND mvp.map_id = mp.map_id
        WHERE m.id = _match.id;
    -- Loop to build the pattern array
    WHILE array_length(pattern, 1) IS DISTINCT FROM coalesce(array_length(pool, 1), 0) - 1 LOOP
        -- Count the number of 'Pick' elements in the pattern array
        picks_count := 0;
        IF array_length(pattern, 1) IS NOT NULL THEN
            FOR i IN 1..array_length(pattern, 1) LOOP
                IF pattern[i] = 'Pick' THEN
                    picks_count := picks_count + 1;
                END IF;
            END LOOP;
        END IF;
        -- Logic for adding elements to the pattern array
        IF picks_count = best_of - 1 THEN
            pattern := array_append(pattern, 'Ban');
            CONTINUE;
        END IF;
        picks_left := coalesce(array_length(pool, 1), 0) - coalesce(array_length(pattern, 1), 0) - 1;
        IF picks_left < picks_count + 2 THEN
            pattern := array_append(pattern, 'Pick');
            CONTINUE;
        END IF;
        pattern := pattern || base_pattern[1:picks_left];
    END LOOP;
    -- Insert 'Side' elements after each 'Pick' in the pattern array
    pattern_length := coalesce(array_length(pattern, 1), 0);
    i := 1;
    WHILE i <= pattern_length LOOP
        IF pattern[i] = 'Pick' THEN
            pattern := array_cat(array_cat(pattern[1:i], ARRAY['Side']), pattern[i+1:pattern_length]);
            pattern_length := pattern_length + 1;
            i := i + 1; -- Skip the next element as it is newly added
        END IF;
        i := i + 1;
    END LOOP;
    RETURN pattern;
END;
$$;
CREATE FUNCTION public.get_veto_picking_lineup_id(_match public.matches) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    lineup_id uuid;
    total_picks int;
    round_num int;
    starting_team int;
    picks_made int;
    team int;    
BEGIN 
    IF _match.status != 'Veto' THEN
        RETURN NULL;
    END IF;
    -- Count the total number of picks made for the match
    SELECT COUNT(*) INTO total_picks
    FROM match_veto_picks mvp
    WHERE mvp.match_id = _match.id;
    -- Calculate the round number
    round_num := floor(total_picks / 6);
    -- Determine the starting team based on the round number
    IF round_num % 2 = 0 THEN
        starting_team := 1;
    ELSE
        starting_team := 2;
    END IF;
    -- Determine the team based on the number of picks made within the round
    picks_made := total_picks % 6;
    IF picks_made < 4 THEN
        IF (starting_team = 1 AND picks_made % 2 = 0) OR
           (starting_team = 2 AND picks_made % 2 <> 0) THEN
            team := 1;
        ELSE
            team := 2;
        END IF;
    ELSE
        -- After the fourth pick within a round, switch the teams
        IF (starting_team = 1 AND picks_made % 2 = 0) OR
           (starting_team = 2 AND picks_made % 2 <> 0) THEN
            team := 2;
        ELSE
            team := 1;
        END IF;
    END IF;
    -- Determine the lineup ID based on the team
    IF team = 1 THEN
        SELECT get_match_lineup_1_id(m.*) INTO lineup_id
        FROM matches m
        WHERE m.id = _match.id
        LIMIT 1;
    ELSE
        SELECT get_match_lineup_2_id(m.*) INTO lineup_id
        FROM matches m
        WHERE m.id = _match.id
        LIMIT 1;
    END IF;
    -- Return the lineup ID
    RETURN lineup_id;
END;
$$;
CREATE FUNCTION public.get_veto_type(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    bestOf int;
    totalPicks int;
    hasMapVeto boolean;
    vetoPattern VARCHAR[];
    pickType VARCHAR(255);
    available_maps uuid[];
    lastPick match_veto_picks%ROWTYPE;
BEGIN
    select map_veto, best_of into hasMapVeto, bestOf from match_options where id = match.match_options_id;
	IF match.status != 'Veto' OR hasMapVeto = false THEN
	 return '';
	END IF;
    vetoPattern = get_veto_pattern(match);
    -- Get the last pick from match_veto_picks table
    SELECT * INTO lastPick FROM match_veto_picks WHERE match_id = match.id ORDER BY created_at DESC LIMIT 1;
    -- Count total picks for the match
    SELECT COUNT(*) INTO totalPicks FROM match_veto_picks WHERE match_id = match.id;
    -- Determine pick type based on match_best_of and totalPicks
    IF bestOf = 1 THEN
        pickType := 'Ban';
    ELSE
        pickType := vetoPattern[totalPicks + 1];
    END IF;
    -- Get available maps for the match
    SELECT array_agg(mp.map_id) INTO available_maps
        FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        LEFT JOIN match_veto_picks mvp ON mvp.match_id = match.id AND mvp.map_id = mp.map_id
        WHERE m.id = match.id
        AND mvp IS NULL;
    -- If only one map is available, set pickType to 'Decider'
    IF array_length(available_maps, 1) = 1 THEN
        pickType := 'Decider';
    END IF;
	return pickType;
END
$$;
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
CREATE FUNCTION public.has_active_matches(match_options public.match_options) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM match_options mo
        INNER JOIN matches m ON m.match_options_id = mo.id
        WHERE mo.id = match_options.id AND m.status != 'PickingPlayers'
    ) INTO match_exists;
    RETURN match_exists;
END;
$$;
CREATE FUNCTION public.insert_into_v_map_pools() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 	INSERT INTO _map_pool (map_id, map_pool_id)
    VALUES (NEW.id, NEW.map_pool_id);
    RETURN NULL;
END;
$$;
CREATE FUNCTION public.is_match_server_available(match public.matches) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
 	IF match.server_id IS NULL THEN
        RETURN false;
    END IF;
    RETURN is_server_available(match.server_id, match.id);
END;
$$;
CREATE FUNCTION public.is_server_available(match_id uuid, match_server_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM servers s
        INNER JOIN matches m ON m.server_id = s.id
        WHERE s.id = match_server_id AND m.status = 'Live' and m.id != match_id
    ) THEN
        RETURN false;
    END IF;
    RETURN true;
END;
$$;
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
CREATE FUNCTION public.is_team_damage(player_damage public.player_damages) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
      return   player_damage.attacker_team = player_damage.attacked_team;
END;
$$;
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
CREATE FUNCTION public.lineup_1_score(match_map public.match_maps) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    score int = 0;
BEGIN
    select lineup_1_score into score from match_map_rounds mmr
    where mmr.match_map_id = match_map.id
	order by time desc
	limit 1;
  IF score IS NULL THEN
        score := 0;
    END IF;
	return score;	
END;
$$;
CREATE FUNCTION public.lineup_2_score(match_map public.match_maps) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    score int;
BEGIN
    select lineup_2_score into score from match_map_rounds mmr
    where mmr.match_map_id = match_map.id
	order by time desc
	limit 1;
  IF score IS NULL THEN
        score := 0;
    END IF;
	return score;	
END;
$$;
CREATE FUNCTION public.set_current_timestamp_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  _new record;
BEGIN
  _new := NEW;
  _new."updated_at" = NOW();
  RETURN _new;
END;
$$;
CREATE FUNCTION public.tbd_remove_match_map() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM match_maps WHERE map_id = OLD.map_id AND match_id = OLD.match_id;
    RETURN OLD;
END;
$$;
CREATE FUNCTION public.tbiu_check_match_map_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id uuid;
    match_best_of INTEGER;
	match_maps_count INTEGER;
BEGIN
	_match_id := COALESCE(NEW.match_id, OLD.match_id);
	SELECT mo.best_of INTO match_best_of FROM matches m
	    inner join match_options mo on mo.id = m.match_options_id
	 WHERE m.id = _match_id;
	SELECT count(*) INTO match_maps_count from match_maps where match_id = _match_id;
	IF (OLD.match_id IS DISTINCT FROM NEW.match_id AND match_maps_count >= match_best_of) THEN
		RAISE EXCEPTION 'Match already has the maximum number of picked maps' USING ERRCODE = '22000';
	END IF;	
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.tbiu_encrypt_rcon() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, current_setting('fivestack.app_key'));
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.tbu_match_player_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    player_count INTEGER;
    max_players INTEGER;
   	match_type VARCHAR(255);
BEGIN
	SELECT type into match_type 
		from match_options
		where id = NEW.match_options_id;
	IF match_type = 'Scrimmage' or NEW.status = 'PickingPlayers' or NEW.status = 'Canceled' THEN
        return NEW;
    END IF;
    SELECT COUNT(*) INTO player_count
    FROM match_lineup_players mlp
    	INNER JOIN match_lineups ml on ml.id = mlp.match_lineup_id
    	INNER JOIN matches m on m.id = ml.match_id
    	where m.id = NEW.id;
	max_players := 10;
    IF match_type = 'Wingman' THEN
        max_players := 4;
    END IF;
	IF player_count < max_players THEN
		RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Not enough players to schedule match';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.tbu_match_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    best_of int;
    map_veto boolean;
    match_map_count int;
BEGIN
    IF (NEW.status != 'Live' AND NEW.status != 'Veto') OR NEW.server_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT mo.map_veto, mo.best_of INTO map_veto, best_of FROM matches m
        inner join match_options mo on mo.id = m.match_options_id
     WHERE m.id = NEW.id;
    IF map_veto = FALSE THEN
        SELECT COUNT(*) INTO match_map_count FROM match_maps WHERE match_id = NEW.id;	
        IF match_map_count != best_of THEN 
            RAISE EXCEPTION 'Cannot start match because a map needs to be selected' USING ERRCODE = '22000';
        END IF;
    END IF;
    IF NOT is_server_available(NEW.id, NEW.server_id) THEN
        RAISE EXCEPTION 'Cannot start match because a server is not available' USING ERRCODE = '22000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.tbui_match_lineup_players() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id uuid;    
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.captain = true THEN
            UPDATE match_lineup_players
            SET captain = false
            WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.steam_id IS NULL AND NEW.discord_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'steam_id or discord_id is required';
    END IF;
    SELECT ml.match_id INTO _match_id 
    FROM match_lineups ml
    WHERE ml.id = NEW.match_lineup_id;
	IF EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id and ml.match_id = _match_id
        WHERE mlp.steam_id = NEW.steam_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Player is already added to match';
    END IF;
    IF NEW.captain = true THEN
        UPDATE match_lineup_players
        SET captain = false
        WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.team_invite_check_for_existing_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	 IF EXISTS (SELECT 1 FROM team_roster WHERE team_id = NEW.team_id AND player_steam_id = NEW.steam_id) THEN
		RAISE EXCEPTION 'Player already on team.';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.update_match_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    DECLARE
        match_best_of INT;
    BEGIN
        SELECT mo.best_of INTO match_best_of FROM matches
        inner join match_options mo on mo.id = m.match_options_id
         WHERE id = NEW.match_id;
        IF (NEW.order = match_best_of AND NEW.status = 'Finished') THEN
            UPDATE matches SET status = 'Finished' WHERE id = NEW.match_id;
        END IF;
        RETURN NEW;
    END;
END;
$$;
CREATE FUNCTION public.update_total_damage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    total_damage integer;
BEGIN
    -- Calculate the total damage for the attacked player in the same round and match
    SELECT COALESCE(SUM(damage), 0) INTO total_damage
    FROM player_damages
    WHERE
        round = NEW.round 
        AND match_id = NEW.match_id
        AND match_map_id = NEW.match_map_id 
        AND attacked_steam_id = NEW.attacked_steam_id;
    -- If the total damage plus the new damage exceeds 100, adjust the new damage
    IF total_damage + NEW.damage > 100 THEN
        NEW.damage := 100 - total_damage;
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION public.update_tournament_stages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    stage RECORD;
    round int;
    max_round int;
    parents uuid[] := '{}';
    available_parents uuid[];
    matches_for_round int;
    max_matches int;
    created_matches int;
    parent_id uuid;
    new_id uuid;
    match_number int;
    tournament_status text;
    total_teams int;
    _tournament_id uuid;
BEGIN
    -- Determine the correct tournament_id to use based on the table
    IF TG_TABLE_NAME = 'tournament_stages' THEN
        _tournament_id := NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'tournaments' THEN
        _tournament_id := NEW.id;
    ELSE
        RAISE EXCEPTION 'Trigger function is not compatible with the table: %', TG_TABLE_NAME;
    END IF;
    -- Get the tournament status
    SELECT status INTO tournament_status 
    FROM tournaments 
    WHERE id = _tournament_id;
    -- Get the total number of teams
    SELECT count(*) INTO total_teams 
    FROM tournament_teams 
    WHERE tournament_id = _tournament_id;
    -- Process each stage
    FOR stage IN
        SELECT *
        FROM tournament_stages
        WHERE tournament_id = _tournament_id
        ORDER BY "order"
    LOOP
        -- Delete existing brackets for this stage
        DELETE FROM tournament_brackets WHERE tournament_stage_id = stage.id;
        -- Calculate the maximum number of rounds and matches based on the status
        IF tournament_status = 'Setup' THEN
            max_round := ceil(log(stage.max_teams) / log(2));
            max_matches := stage.max_teams - 1;
        ELSE
            max_round := ceil(log(total_teams) / log(2));
            max_matches := total_teams - 1;
        END IF;
		 RAISE NOTICE 'totals: max_round=%, max_matches=%', max_round,max_matches;
        match_number := max_matches;
        -- Create the last match first
        INSERT INTO tournament_brackets (round, tournament_stage_id, match_number)
        VALUES (max_round, stage.id, match_number) RETURNING id INTO new_id;
        RAISE NOTICE 'match_number: match_number=%', match_number;
        parents := array_append(parents, new_id);
        -- Initialize for the next rounds
        round := max_round - 1;
        matches_for_round := 2;
        WHILE round > 0 AND matches_for_round * 2 <= COALESCE(stage.max_teams, total_teams) LOOP
            created_matches := 0;
            available_parents := parents;
            parents := '{}';
            RAISE NOTICE 'Processing round: round=%, matches=%, parents=%',
                round, matches_for_round, available_parents;
            WHILE created_matches < matches_for_round LOOP
                parent_id := available_parents[array_length(available_parents, 1)];
                available_parents := array_remove(available_parents, parent_id);
                match_number := match_number - 1;
                -- Create two matches for each parent
                INSERT INTO tournament_brackets (round, tournament_stage_id, parent_bracket_id, match_number)
                    VALUES (round, stage.id, parent_id, match_number) RETURNING id INTO new_id;
                parents := array_append(parents, new_id);
                INSERT INTO tournament_brackets (round, tournament_stage_id, parent_bracket_id, match_number)
                    VALUES (round, stage.id, parent_id, match_number - 1) RETURNING id INTO new_id;
                parents := array_append(parents, new_id);
                created_matches := created_matches + 2;
            END LOOP;
            round := round - 1;
            matches_for_round := matches_for_round * 2;
        END LOOP;
    END LOOP;
    RETURN NEW;
END;
$$;
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
CREATE TABLE public.match_lineup_players (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    steam_id bigint,
    match_lineup_id uuid NOT NULL,
    discord_id text,
    captain boolean DEFAULT false NOT NULL,
    placeholder_name text,
    CONSTRAINT chk_null_steam_id_place_holder_name CHECK ((((steam_id IS NOT NULL) AND (placeholder_name IS NULL)) OR ((steam_id IS NULL) AND (placeholder_name IS NOT NULL))))
);
COMMENT ON TABLE public.match_lineup_players IS 'relational table for assigning a players to a match and lineup';
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
CREATE TABLE public.match_veto_picks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    type text NOT NULL,
    match_lineup_id uuid NOT NULL,
    map_id uuid NOT NULL,
    side text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE public.team_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    steam_id bigint NOT NULL,
    invited_by_player_steam_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.team_roster (
    player_steam_id bigint NOT NULL,
    team_id uuid NOT NULL,
    role text DEFAULT 'Pending'::text NOT NULL
);
CREATE TABLE public.tournament_brackets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tournament_stage_id uuid NOT NULL,
    match_id uuid,
    roster_1_id uuid,
    roster_2_id uuid,
    parent_bracket_id uuid,
    round integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    match_number integer
);
CREATE TABLE public.tournament_organizers (
    steam_id bigint NOT NULL,
    tournament_id uuid NOT NULL
);
CREATE TABLE public.tournament_servers (
    server_id uuid NOT NULL,
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
CREATE TABLE public.tournament_team_roster (
    tournament_team_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    tournament_id uuid NOT NULL,
    role text DEFAULT 'Member'::text NOT NULL
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
CREATE VIEW public.v_match_captains AS
 SELECT mlp.steam_id,
    mlp.match_lineup_id,
    mlp.discord_id,
    mlp.captain,
    mlp.placeholder_name,
    mlp.id
   FROM public.match_lineup_players mlp
  WHERE (mlp.captain = true);
CREATE VIEW public.v_player_arch_nemesis AS
 SELECT DISTINCT ON (player_kills.attacker_steam_id) player_kills.attacker_steam_id AS attacker_id,
    player_kills.attacked_steam_id AS victim_id,
    count(*) AS kill_count
   FROM public.player_kills
  GROUP BY player_kills.attacker_steam_id, player_kills.attacked_steam_id
  ORDER BY player_kills.attacker_steam_id, (count(*)) DESC;
CREATE VIEW public.v_player_damage AS
 WITH matchroundscount AS (
         SELECT pd.attacker_steam_id AS player_steam_id,
            sum(pd.damage) AS total_damage,
            count(DISTINCT mr.id) AS match_total_rounds
           FROM (public.player_damages pd
             LEFT JOIN public.match_map_rounds mr ON ((mr.match_map_id = pd.match_id)))
          GROUP BY pd.attacker_steam_id
        )
 SELECT matchroundscount.player_steam_id,
    matchroundscount.total_damage,
    matchroundscount.match_total_rounds AS total_rounds,
        CASE
            WHEN (matchroundscount.match_total_rounds > 0) THEN (matchroundscount.total_damage / matchroundscount.match_total_rounds)
            ELSE NULL::bigint
        END AS avg_damage_per_round
   FROM matchroundscount;
CREATE VIEW public.v_player_killed_player_counts AS
 SELECT player_kills.attacker_steam_id AS player_id,
    player_kills.attacked_steam_id AS victim_id,
    count(*) AS kill_count
   FROM public.player_kills
  GROUP BY player_kills.attacker_steam_id, player_kills.attacked_steam_id
  ORDER BY player_kills.attacker_steam_id, player_kills.attacked_steam_id;
CREATE VIEW public.v_player_match_kills AS
 SELECT player_kills.attacker_steam_id AS player_steam_id,
    count(*) AS kills,
    ( SELECT count(DISTINCT subquery.match_id) AS count
           FROM public.player_kills subquery
          WHERE (subquery.attacker_steam_id = player_kills.attacker_steam_id)) AS total_matches,
    (count(*) / ( SELECT count(DISTINCT subquery.match_id) AS count
           FROM public.player_kills subquery
          WHERE (subquery.attacker_steam_id = player_kills.attacker_steam_id))) AS avg_kills_per_game
   FROM public.player_kills
  GROUP BY player_kills.attacker_steam_id
  ORDER BY (count(*) / ( SELECT count(DISTINCT subquery.match_id) AS count
           FROM public.player_kills subquery
          WHERE (subquery.attacker_steam_id = player_kills.attacker_steam_id))) DESC;
CREATE VIEW public.v_player_multi_kills AS
 SELECT player_kills.match_id,
    player_kills.attacker_steam_id,
    player_kills.round,
    count(*) AS kills
   FROM public.player_kills
  GROUP BY player_kills.match_id, player_kills.round, player_kills.attacker_steam_id;
CREATE VIEW public.v_player_opening_duels AS
 WITH ranked_kills AS (
         SELECT player_kills.match_id,
            player_kills.match_map_id,
            player_kills.attacker_steam_id AS steam_id,
            row_number() OVER (PARTITION BY player_kills.match_id, player_kills.match_map_id, player_kills.round ORDER BY player_kills."time") AS kill_rank,
            true AS is_attacker,
            (player_kills.attacker_steam_id = player_kills.attacked_steam_id) AS is_success
           FROM public.player_kills
        UNION ALL
         SELECT player_kills.match_id,
            player_kills.match_map_id,
            player_kills.attacked_steam_id AS steam_id,
            row_number() OVER (PARTITION BY player_kills.match_id, player_kills.match_map_id, player_kills.round ORDER BY player_kills."time") AS kill_rank,
            false AS is_attacker,
            (player_kills.attacker_steam_id <> player_kills.attacked_steam_id) AS is_success
           FROM public.player_kills
        )
 SELECT ranked_kills.match_id,
    ranked_kills.match_map_id,
    ranked_kills.steam_id,
    sum(
        CASE
            WHEN (ranked_kills.is_attacker = true) THEN 1
            ELSE 0
        END) AS attempts,
    sum((
        CASE
            WHEN (ranked_kills.is_attacker = true) THEN 1
            ELSE 0
        END *
        CASE
            WHEN (ranked_kills.is_attacker = ranked_kills.is_success) THEN 1
            ELSE 0
        END)) AS successes
   FROM ranked_kills
  WHERE (ranked_kills.kill_rank = 1)
  GROUP BY ranked_kills.match_id, ranked_kills.match_map_id, ranked_kills.steam_id;
CREATE VIEW public.v_pool_maps AS
 SELECT _map_pool.map_pool_id,
    maps.id,
    maps.name,
    maps.type,
    maps.poster,
    maps.patch,
    maps.active_pool,
    maps.workshop_map_id
   FROM (public._map_pool
     LEFT JOIN public.maps ON ((_map_pool.map_id = maps.id)));
ALTER TABLE ONLY public.e_map_pool_types
    ADD CONSTRAINT e_map_pool_types_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_match_status
    ADD CONSTRAINT e_match_status_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_match_types
    ADD CONSTRAINT e_match_types_pkey PRIMARY KEY (value);
ALTER TABLE ONLY public.e_objective_types
    ADD CONSTRAINT e_objective__pkey PRIMARY KEY (value);
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
ALTER TABLE ONLY public.match_veto_picks
    ADD CONSTRAINT match_veto_picks_pkey PRIMARY KEY (id);
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
ALTER TABLE ONLY public.tournament_organizers
    ADD CONSTRAINT tournament_organizers_pkey PRIMARY KEY (steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_pkey PRIMARY KEY (player_steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_team_roster
    ADD CONSTRAINT tournament_roster_player_steam_id_tournament_id_key UNIQUE (player_steam_id, tournament_id);
ALTER TABLE ONLY public.tournament_servers
    ADD CONSTRAINT tournament_servers_pkey PRIMARY KEY (server_id, tournament_id);
ALTER TABLE ONLY public.tournament_servers
    ADD CONSTRAINT tournament_servers_server_id_tournament_id_key UNIQUE (server_id, tournament_id);
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
CREATE INDEX lineups_match ON public.match_lineups USING btree (match_id);
CREATE INDEX objectives_player_match ON public.player_objectives USING btree (player_steam_id, match_id);
CREATE INDEX unused_utility_player_match ON public.player_unused_utility USING btree (player_steam_id, match_id);
CREATE INDEX utility_player_match ON public.player_utility USING btree (attacker_steam_id, match_id);
CREATE INDEX veto_match ON public.match_veto_picks USING btree (match_id);
CREATE TRIGGER set_public_matches_updated_at BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_matches_updated_at ON public.matches IS 'trigger to set value of column "updated_at" to current timestamp on row update';
CREATE TRIGGER set_public_players_updated_at BEFORE UPDATE ON public.players FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_players_updated_at ON public.players IS 'trigger to set value of column "updated_at" to current timestamp on row update';
CREATE TRIGGER tai_create_match_map_from_veto AFTER INSERT ON public.match_veto_picks FOR EACH ROW EXECUTE FUNCTION public.create_match_map_from_veto();
CREATE TRIGGER tai_teams AFTER INSERT ON public.teams FOR EACH ROW EXECUTE FUNCTION public.add_owner_to_team();
CREATE TRIGGER taiu_tournament_stages AFTER INSERT OR UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.update_tournament_stages();
CREATE TRIGGER taiud AFTER INSERT OR DELETE OR UPDATE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.check_team_eligibility();
CREATE TRIGGER tau_seed_tournament AFTER UPDATE ON public.tournaments FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) AND (new.status = 'Scheduled'::text))) EXECUTE FUNCTION public.update_tournament_stages();
CREATE TRIGGER tau_update_match_state AFTER UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.update_match_state();
CREATE TRIGGER tbd_remove_match_map BEFORE DELETE ON public.match_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tbd_remove_match_map();
CREATE TRIGGER tbi_match_lineup_players BEFORE INSERT ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.check_match_lineup_players_count();
CREATE TRIGGER tbi_match_lineups BEFORE INSERT ON public.match_lineups FOR EACH ROW EXECUTE FUNCTION public.check_max_match_lineups();
CREATE TRIGGER tbiu_can_pick_veto BEFORE INSERT OR UPDATE ON public.match_veto_picks FOR EACH ROW EXECUTE FUNCTION public.can_pick_veto();
CREATE TRIGGER tbiu_check_match_map_count BEFORE INSERT OR UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tbiu_check_match_map_count();
CREATE TRIGGER tbiu_encrypt_rcon BEFORE INSERT OR UPDATE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiu_encrypt_rcon();
CREATE TRIGGER tbiu_enforce_max_damage_trigger BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.enforce_max_damage();
CREATE TRIGGER tbiu_team_invite BEFORE INSERT OR UPDATE ON public.team_invites FOR EACH ROW EXECUTE FUNCTION public.team_invite_check_for_existing_member();
CREATE TRIGGER tbiu_update_total_damage_trigger BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.update_total_damage();
CREATE TRIGGER tbu_match_player_count BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_match_player_count();
CREATE TRIGGER tbu_match_status BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_match_status();
CREATE TRIGGER tbui_match_lineup_players BEFORE INSERT OR UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbui_match_lineup_players();
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.insert_into_v_map_pools();
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
ALTER TABLE ONLY public.match_lineups
    ADD CONSTRAINT match_lineups_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
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
ALTER TABLE ONLY public.match_veto_picks
    ADD CONSTRAINT match_veto_picks_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_veto_picks
    ADD CONSTRAINT match_veto_picks_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.match_veto_picks
    ADD CONSTRAINT match_veto_picks_match_lineup_id_fkey FOREIGN KEY (match_lineup_id) REFERENCES public.match_lineups(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE ONLY public.match_veto_picks
    ADD CONSTRAINT match_veto_picks_type_fkey FOREIGN KEY (type) REFERENCES public.e_veto_pick_types(value) ON UPDATE CASCADE ON DELETE RESTRICT;
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
ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_player_steam_id_fkey FOREIGN KEY (owner_steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE;
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
    ADD CONSTRAINT tournament_brackets_tournament_stage_id_fkey FOREIGN KEY (tournament_stage_id) REFERENCES public.tournament_stages(id) ON UPDATE CASCADE ON DELETE CASCADE;
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
ALTER TABLE ONLY public.tournament_servers
    ADD CONSTRAINT tournament_servers_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.tournament_servers
    ADD CONSTRAINT tournament_servers_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE;
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
