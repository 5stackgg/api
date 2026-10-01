-- The roster arrives as JSON; these parse it per statement instead of staging
-- it in a temp table, which would churn the system catalogs on every sync.
DROP FUNCTION IF EXISTS public.server_roster_entries(jsonb);
DROP FUNCTION IF EXISTS public.server_roster_departed(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.server_roster_departed(jsonb);

CREATE FUNCTION public.server_roster_entries(_players jsonb)
RETURNS TABLE (steam_id bigint, conn text, name text, ip inet, kills integer, deaths integer)
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT DISTINCT ON (p.steam_id)
           p.steam_id,
           p.conn,
           p.name,
           p.ip,
           greatest(coalesce(p.kills, 0), 0),
           greatest(coalesce(p.deaths, 0), 0)
      FROM jsonb_to_recordset(coalesce(_players, '[]'::jsonb))
           AS p(steam_id bigint, conn text, name text, ip inet, kills integer, deaths integer)
     WHERE p.steam_id IS NOT NULL;
$$;

-- One entry per connection that ended since the plugin's last recorded sync.
CREATE FUNCTION public.server_roster_departed(_departed jsonb)
RETURNS TABLE (steam_id bigint, conn text, kills integer, deaths integer)
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT DISTINCT ON (d.steam_id, d.conn)
           d.steam_id,
           d.conn,
           greatest(coalesce(d.kills, 0), 0),
           greatest(coalesce(d.deaths, 0), 0)
      FROM jsonb_to_recordset(coalesce(_departed, '[]'::jsonb))
           AS d(steam_id bigint, conn text, kills integer, deaths integer)
     WHERE d.steam_id IS NOT NULL
       AND d.conn IS NOT NULL;
$$;

-- Remembers which connections a session has already absorbed, so a departed
-- entry the plugin resends after a lost response is recognised and ignored.
CREATE OR REPLACE FUNCTION public.server_session_settle_conn(_settled text[], _conn text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN _conn IS NULL OR _conn = ANY(_settled) THEN _settled
        ELSE (_settled || _conn)[greatest(cardinality(_settled) - 18, 1):]
    END;
$$;

-- One call per Player Management sync, applying the full roster snapshot. The
-- server_rosters row is the per-server lock, so a retried sync on another pod
-- and the stale-roster sweeper can never interleave with it.
--
-- Every connection carries an id from the plugin, and its kill and death
-- counters are cumulative for that connection. A session follows its current
-- connection (`conn`, counters so far in `*_conn`); counting is always the
-- difference against what that connection already reported, so a resend adds
-- nothing and a connection is never counted twice.
CREATE OR REPLACE FUNCTION public.sync_server_player_sessions(
    _server_id uuid,
    _players jsonb,
    _departed jsonb DEFAULT '[]'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    _now timestamptz;
    _reported_at timestamptz;
    _online integer;
BEGIN
    INSERT INTO public.server_rosters (server_id, reported_at)
    VALUES (_server_id, '-infinity')
    ON CONFLICT (server_id) DO NOTHING;

    SELECT reported_at
      INTO _reported_at
      FROM public.server_rosters
     WHERE server_id = _server_id
       FOR UPDATE;

    _now := clock_timestamp();

    -- A roster that went quiet ends its open sessions where it was last heard
    -- from. A player who was still on the same connection when it came back
    -- gets that session reopened below, so only a real restart splits it.
    IF _reported_at < _now - interval '2 minutes' THEN
        UPDATE public.server_player_sessions
           SET ended_at = greatest(started_at, _reported_at)
         WHERE server_id = _server_id
           AND ended_at IS NULL;
    END IF;

    -- Final counters of a connection the session is following.
    UPDATE public.server_player_sessions s
       SET kills = s.kills + greatest(d.kills - s.kills_conn, 0),
           kills_conn = greatest(s.kills_conn, d.kills),
           deaths = s.deaths + greatest(d.deaths - s.deaths_conn, 0),
           deaths_conn = greatest(s.deaths_conn, d.deaths)
      FROM public.server_roster_departed(_departed) d
      JOIN LATERAL (
          SELECT current_session.id
            FROM public.server_player_sessions current_session
           WHERE current_session.server_id = _server_id
             AND current_session.player_steam_id = d.steam_id
             AND current_session.conn = d.conn
           ORDER BY current_session.started_at DESC
           LIMIT 1
      ) target ON true
     WHERE s.id = target.id
       AND (d.kills > s.kills_conn OR d.deaths > s.deaths_conn);

    -- A connection that came and went while the panel could not hear it: its
    -- counters land whole on the player's latest session, once.
    UPDATE public.server_player_sessions s
       SET kills = s.kills + d.kills,
           deaths = s.deaths + d.deaths,
           settled_conns = public.server_session_settle_conn(s.settled_conns, d.conn)
      FROM public.server_roster_departed(_departed) d
      JOIN LATERAL (
          SELECT latest.id
            FROM public.server_player_sessions latest
           WHERE latest.server_id = _server_id
             AND latest.player_steam_id = d.steam_id
             AND (latest.ended_at IS NULL OR latest.ended_at >= _now - interval '10 minutes')
           ORDER BY latest.started_at DESC
           LIMIT 1
      ) target ON true
     WHERE s.id = target.id
       AND NOT EXISTS (
           SELECT 1 FROM public.server_player_sessions seen
            WHERE seen.server_id = _server_id
              AND seen.player_steam_id = d.steam_id
              AND (seen.conn = d.conn OR d.conn = ANY(seen.settled_conns))
       );

    -- Still on the connection the session follows.
    UPDATE public.server_player_sessions s
       SET kills = s.kills + greatest(i.kills - s.kills_conn, 0),
           kills_conn = greatest(s.kills_conn, i.kills),
           deaths = s.deaths + greatest(i.deaths - s.deaths_conn, 0),
           deaths_conn = greatest(s.deaths_conn, i.deaths)
      FROM public.server_roster_entries(_players) i
     WHERE s.server_id = _server_id
       AND s.player_steam_id = i.steam_id
       AND s.ended_at IS NULL
       AND s.conn IS NOT DISTINCT FROM i.conn
       AND (i.kills > s.kills_conn OR i.deaths > s.deaths_conn);

    -- Reconnected between two syncs: the session carries on with the new
    -- connection, whose counters start from zero.
    UPDATE public.server_player_sessions s
       SET settled_conns = public.server_session_settle_conn(s.settled_conns, s.conn),
           conn = i.conn,
           kills = s.kills + i.kills,
           kills_conn = i.kills,
           deaths = s.deaths + i.deaths,
           deaths_conn = i.deaths
      FROM public.server_roster_entries(_players) i
     WHERE s.server_id = _server_id
       AND s.player_steam_id = i.steam_id
       AND s.ended_at IS NULL
       AND s.conn IS DISTINCT FROM i.conn;

    UPDATE public.server_player_sessions s
       SET ended_at = greatest(s.started_at, _now)
     WHERE s.server_id = _server_id
       AND s.ended_at IS NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.server_roster_entries(_players) i
            WHERE i.steam_id = s.player_steam_id
       );

    -- Back on the same connection (the roster went quiet, the sweeper ran) or
    -- a new one within two minutes (a reconnect, a map change): continue the
    -- session that ended rather than starting another row.
    UPDATE public.server_player_sessions s
       SET ended_at = NULL,
           kills = s.kills + CASE WHEN s.conn = i.conn
                                  THEN greatest(i.kills - s.kills_conn, 0)
                                  ELSE i.kills END,
           kills_conn = CASE WHEN s.conn = i.conn
                             THEN greatest(s.kills_conn, i.kills)
                             ELSE i.kills END,
           deaths = s.deaths + CASE WHEN s.conn = i.conn
                                    THEN greatest(i.deaths - s.deaths_conn, 0)
                                    ELSE i.deaths END,
           deaths_conn = CASE WHEN s.conn = i.conn
                              THEN greatest(s.deaths_conn, i.deaths)
                              ELSE i.deaths END,
           settled_conns = CASE WHEN s.conn = i.conn
                                THEN s.settled_conns
                                ELSE public.server_session_settle_conn(s.settled_conns, s.conn) END,
           conn = i.conn,
           name = coalesce(i.name, s.name),
           ip = coalesce(i.ip, s.ip)
      FROM public.server_roster_entries(_players) i
      JOIN LATERAL (
          SELECT previous.id
            FROM public.server_player_sessions previous
           WHERE previous.server_id = _server_id
             AND previous.player_steam_id = i.steam_id
             AND previous.ended_at IS NOT NULL
             AND (previous.conn = i.conn OR previous.ended_at >= _now - interval '2 minutes')
           ORDER BY (previous.conn = i.conn) DESC NULLS LAST, previous.started_at DESC
           LIMIT 1
      ) target ON true
     WHERE s.id = target.id
       AND NOT EXISTS (
           SELECT 1 FROM public.server_player_sessions open_session
            WHERE open_session.server_id = _server_id
              AND open_session.player_steam_id = i.steam_id
              AND open_session.ended_at IS NULL
       );

    INSERT INTO public.server_player_sessions
        (server_id, player_steam_id, conn, name, ip, kills, deaths, kills_conn, deaths_conn, started_at)
    SELECT _server_id, i.steam_id, i.conn, i.name, i.ip, i.kills, i.deaths, i.kills, i.deaths, _now
      FROM public.server_roster_entries(_players) i
     WHERE NOT EXISTS (
           SELECT 1 FROM public.server_player_sessions open_session
            WHERE open_session.server_id = _server_id
              AND open_session.player_steam_id = i.steam_id
              AND open_session.ended_at IS NULL
       )
    ON CONFLICT (server_id, player_steam_id) WHERE ended_at IS NULL DO NOTHING;

    UPDATE public.server_player_sessions s
       SET name = coalesce(i.name, s.name),
           ip = coalesce(i.ip, s.ip)
      FROM public.server_roster_entries(_players) i
     WHERE s.server_id = _server_id
       AND s.player_steam_id = i.steam_id
       AND s.ended_at IS NULL
       AND (s.name IS DISTINCT FROM coalesce(i.name, s.name)
            OR s.ip IS DISTINCT FROM coalesce(i.ip, s.ip));

    UPDATE public.server_rosters
       SET reported_at = _now,
           held_since = NULL
     WHERE server_id = _server_id;

    SELECT count(*)::int
      INTO _online
      FROM public.server_player_sessions
     WHERE server_id = _server_id
       AND ended_at IS NULL;

    RETURN _online;
END;
$$;

-- Ends every open session of a server whose roster stopped reporting (server
-- gone, plugin removed, panel unreachable from the server), at the moment it
-- was last heard from. Skips a roster a sync is holding right now; the sync
-- will refresh it anyway.
CREATE OR REPLACE FUNCTION public.close_stale_server_player_sessions(_stale_after interval)
RETURNS SETOF uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _roster record;
BEGIN
    FOR _roster IN
        SELECT sr.server_id, sr.reported_at
          FROM public.server_rosters sr
         WHERE sr.reported_at < clock_timestamp() - _stale_after
           AND EXISTS (
               SELECT 1 FROM public.server_player_sessions s
                WHERE s.server_id = sr.server_id
                  AND s.ended_at IS NULL
           )
           FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE public.server_player_sessions
           SET ended_at = greatest(started_at, _roster.reported_at)
         WHERE server_id = _roster.server_id
           AND ended_at IS NULL;

        RETURN NEXT _roster.server_id;
    END LOOP;
END;
$$;

-- Moves closed sessions older than the cutoff into the all-time totals in the
-- same statement that deletes them, so a session is always counted exactly
-- once: by server_player_sessions while it exists, by server_player_stats after.
CREATE OR REPLACE FUNCTION public.prune_server_player_sessions(_older_than timestamptz, _batch integer)
RETURNS integer
LANGUAGE sql
AS $$
    WITH pruned AS (
        DELETE FROM public.server_player_sessions
         WHERE id IN (
             SELECT id
               FROM public.server_player_sessions
              WHERE ended_at IS NOT NULL
                AND ended_at < _older_than
              ORDER BY ended_at
              LIMIT _batch
         )
        RETURNING server_id, player_steam_id, started_at, ended_at, kills, deaths
    ),
    rolled_up AS (
        INSERT INTO public.server_player_stats AS stats
            (server_id, player_steam_id, sessions, seconds_played, kills, deaths, first_seen_at, last_seen_at)
        SELECT server_id,
               player_steam_id,
               count(*)::int,
               sum(extract(epoch FROM ended_at - started_at)::bigint)::bigint,
               sum(kills)::int,
               sum(deaths)::int,
               min(started_at),
               max(ended_at)
          FROM pruned
         GROUP BY server_id, player_steam_id
        ON CONFLICT (server_id, player_steam_id) DO UPDATE
           SET sessions = stats.sessions + EXCLUDED.sessions,
               seconds_played = stats.seconds_played + EXCLUDED.seconds_played,
               kills = stats.kills + EXCLUDED.kills,
               deaths = stats.deaths + EXCLUDED.deaths,
               first_seen_at = least(stats.first_seen_at, EXCLUDED.first_seen_at),
               last_seen_at = greatest(stats.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING 1
    )
    SELECT count(*)::int FROM pruned;
$$;

-- Player-seconds and distinct players per hour for the public activity chart.
CREATE OR REPLACE FUNCTION public.server_hourly_activity(_server_id uuid, _hours integer)
RETURNS TABLE (hour timestamptz, seconds integer, players integer)
LANGUAGE sql
STABLE
AS $$
    WITH bounds AS (
        SELECT date_trunc('hour', now()) - make_interval(hours => _hours - 1) AS first_hour
    ),
    hours AS (
        SELECT generate_series(b.first_hour, date_trunc('hour', now()), interval '1 hour') AS hour
          FROM bounds b
    ),
    sessions AS (
        SELECT s.player_steam_id, s.started_at, coalesce(s.ended_at, now()) AS ended_at
          FROM public.server_player_sessions s, bounds b
         WHERE s.server_id = _server_id
           AND coalesce(s.ended_at, now()) > b.first_hour
    )
    -- least() and greatest() skip NULLs, so an hour with no session would
    -- otherwise count as a full hour played.
    SELECT h.hour,
           coalesce(sum(extract(epoch FROM least(s.ended_at, h.hour + interval '1 hour')
                                        - greatest(s.started_at, h.hour)))
                    FILTER (WHERE s.player_steam_id IS NOT NULL), 0)::int,
           count(DISTINCT s.player_steam_id)::int
      FROM hours h
      LEFT JOIN sessions s
        ON s.started_at < h.hour + interval '1 hour'
       AND s.ended_at > h.hour
     GROUP BY h.hour
     ORDER BY h.hour;
$$;
