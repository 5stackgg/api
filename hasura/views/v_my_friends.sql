CREATE OR REPLACE VIEW "public"."v_my_friends" AS
WITH friend_relationships AS (
  -- Get all friend relationships in both directions
  SELECT 
    f.player_steam_id,
    f.other_player_steam_id,
    f.status,
    f.other_player_steam_id AS friend_steam_id,
    f.player_steam_id AS invited_by_steam_id
  FROM friends f
  
  UNION ALL
  
  SELECT 
    f.other_player_steam_id AS player_steam_id,
    f.player_steam_id AS other_player_steam_id,
    f.status,
    f.player_steam_id AS friend_steam_id,
    f.other_player_steam_id AS invited_by_steam_id
  FROM friends f
),
latest_elos AS (
  -- Get the latest ELO for each player more efficiently
  SELECT DISTINCT ON (steam_id)
    steam_id,
    current AS elo
  FROM player_elo
  ORDER BY steam_id, created_at DESC
)
SELECT DISTINCT
  p.*,
  fr.status,
  fr.friend_steam_id,
  fr.invited_by_steam_id,
  COALESCE(le.elo, 5000) AS elo
FROM friend_relationships fr
JOIN players p ON p.steam_id = fr.player_steam_id
LEFT JOIN latest_elos le ON le.steam_id = p.steam_id;