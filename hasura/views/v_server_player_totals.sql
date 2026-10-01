DROP VIEW IF EXISTS public.v_server_player_totals;

-- All-time totals per player per server: what the prune job already folded
-- into server_player_stats plus the sessions still retained. A session is in
-- exactly one of the two, so nothing is counted twice.
CREATE VIEW public.v_server_player_totals AS
SELECT t.server_id,
       t.player_steam_id,
       sum(t.sessions)::int AS sessions,
       sum(t.seconds_played)::bigint AS seconds_played,
       sum(t.kills)::int AS kills,
       sum(t.deaths)::int AS deaths,
       min(t.first_seen_at) AS first_seen_at,
       max(t.last_seen_at) AS last_seen_at
  FROM (
      SELECT st.server_id, st.player_steam_id, st.sessions, st.seconds_played,
             st.kills, st.deaths, st.first_seen_at, st.last_seen_at
        FROM public.server_player_stats st
      UNION ALL
      SELECT s.server_id, s.player_steam_id, 1,
             extract(epoch FROM coalesce(s.ended_at, now()) - s.started_at)::bigint,
             s.kills, s.deaths, s.started_at, coalesce(s.ended_at, now())
        FROM public.server_player_sessions s
  ) t
 GROUP BY t.server_id, t.player_steam_id;
