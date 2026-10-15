-- Strictly above: nobody sanctions an equal or a higher role, administrators
-- included.
CREATE OR REPLACE FUNCTION public.can_sanction_player(actor_role text, target_steam_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        array_position(
            ARRAY['user', 'verified_user', 'streamer', 'moderator', 'match_organizer', 'tournament_organizer', 'administrator'],
            actor_role
        ) > COALESCE(
            array_position(
                ARRAY['user', 'verified_user', 'streamer', 'moderator', 'match_organizer', 'tournament_organizer', 'administrator'],
                (SELECT p.role::text FROM public.players p WHERE p.steam_id = target_steam_id)
            ),
            1
        ),
        false
    );
$$;
