CREATE OR REPLACE VIEW "public"."v_my_friends" AS
 SELECT DISTINCT
    p.*,
    f.status,
    f.other_player_steam_id AS friend_steam_id,
    f.player_steam_id AS invited_by_steam_id
   FROM friends f
     JOIN players p ON p.steam_id = f.player_steam_id
UNION
 SELECT DISTINCT
    p.*,
    f.status,
    f.player_steam_id AS friend_steam_id,
    f.player_steam_id AS invited_by_steam_id
   FROM friends f
     JOIN players p ON p.steam_id = f.other_player_steam_id;