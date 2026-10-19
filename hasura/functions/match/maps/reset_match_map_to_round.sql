-- Puts a map's rounds and stats back to how they stood after _round, the round
-- whose backup the server is about to load (0 for a map started over).
--
-- Nothing played is deleted here: rounds after _round are only soft-deleted,
-- and ScoreEvent removes them once the next round is played. Until then a
-- later reset can still bring them back, so everything soft-deleted is restored
-- first. The stats of the round that was in progress belong to no round that
-- was played, and would be counted twice once a restore brings back that round
-- number, so they are dropped.
--
-- The map's rounds are locked first, the order ScoreEvent's cleanup takes them
-- in, so the two can't deadlock.
CREATE OR REPLACE FUNCTION public.reset_match_map_to_round(_match_map_id uuid, _round int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _last_played int;
    _restored match_map_rounds%ROWTYPE;
BEGIN
    PERFORM 1
    FROM match_map_rounds
    WHERE match_map_id = _match_map_id
    ORDER BY round
    FOR UPDATE;

    IF _round > 0 AND NOT EXISTS (
        SELECT 1
        FROM match_map_rounds
        WHERE match_map_id = _match_map_id
          AND round = _round
    ) THEN
        RAISE EXCEPTION 'there is no round % on this map to go back to', _round
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT COALESCE(max(round), 0)
    INTO _last_played
    FROM match_map_rounds
    WHERE match_map_id = _match_map_id
      AND deleted_at IS NULL;

    DELETE FROM player_kills WHERE match_map_id = _match_map_id AND deleted_at IS NULL AND round > _last_played;
    DELETE FROM player_assists WHERE match_map_id = _match_map_id AND deleted_at IS NULL AND round > _last_played;
    DELETE FROM player_damages WHERE match_map_id = _match_map_id AND deleted_at IS NULL AND round > _last_played;
    DELETE FROM player_flashes WHERE match_map_id = _match_map_id AND deleted_at IS NULL AND round > _last_played;
    DELETE FROM player_utility WHERE match_map_id = _match_map_id AND deleted_at IS NULL AND round > _last_played;
    DELETE FROM player_objectives WHERE match_map_id = _match_map_id AND deleted_at IS NULL AND round > _last_played;

    UPDATE player_kills SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE player_assists SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE player_damages SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE player_flashes SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE player_utility SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE player_objectives SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE player_unused_utility SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;
    UPDATE match_map_rounds SET deleted_at = NULL WHERE match_map_id = _match_map_id AND deleted_at IS NOT NULL;

    UPDATE player_kills SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;
    UPDATE player_assists SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;
    UPDATE player_damages SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;
    UPDATE player_flashes SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;
    UPDATE player_utility SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;
    UPDATE player_objectives SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;
    UPDATE player_unused_utility SET deleted_at = now() WHERE match_map_id = _match_map_id;
    UPDATE match_map_rounds SET deleted_at = now() WHERE match_map_id = _match_map_id AND round > _round;

    SELECT * INTO _restored
    FROM match_map_rounds
    WHERE match_map_id = _match_map_id
      AND round = _round;

    IF FOUND THEN
        UPDATE match_maps
        SET lineup_1_timeouts_available = _restored.lineup_1_timeouts_available,
            lineup_2_timeouts_available = _restored.lineup_2_timeouts_available
        WHERE id = _match_map_id;
    ELSIF _round = 0 THEN
        UPDATE match_maps
        SET lineup_1_timeouts_available = DEFAULT,
            lineup_2_timeouts_available = DEFAULT
        WHERE id = _match_map_id;
    END IF;
END;
$$;
