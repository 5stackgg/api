-- The matchmaking half of the sanctions policy. The escalation ladder, the decay
-- window and whether this fires at all now live in settings (see
-- hasura/functions/sanctions/sanction_policy.sql); the shipped defaults for
-- match_abandon reproduce exactly what was hardcoded here before -- a 7 day
-- window and the 10/60/120/240/480/960/1920 minute ladder, counted from the last
-- abandon -- so turning the policy on changes nothing until an operator edits it.
--
-- The window is still counted rather than the rows being deleted. The escalation
-- used to be forgiven by CleanAbandonedMatches deleting the rows, which made the
-- record too short-lived to recompute elo from: a leaver penalty applied at match
-- time silently vanished from any later recompute.
CREATE OR REPLACE FUNCTION get_player_matchmaking_cooldown(player public.players, hasura_session json)
RETURNS TIMESTAMP WITH TIME ZONE AS $$
DECLARE
    cooldown_time TIMESTAMP WITH TIME ZONE;
BEGIN

    IF (hasura_session ->> 'x-hasura-user-id')::bigint != player.steam_id::bigint THEN
        RETURN NULL;
    END IF;

    cooldown_time := public.player_sanction_expiry(player.steam_id, 'matchmaking');

    IF cooldown_time > NOW() THEN
        RETURN cooldown_time;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql stable;
