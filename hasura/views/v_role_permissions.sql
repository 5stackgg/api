-- One row per role, saying which settings-driven minimum-role gates that role
-- clears (public.create_matches_role and friends). Replaces one insert
-- permission per role, each with a hand-maintained list of the setting values
-- at or below it -- seven copies that drifted: every list on matches and
-- tournaments was missing 'moderator', so selecting that role denied everyone
-- but an administrator.
--
-- Keyed by role rather than read from the session, so a permission matches it
-- with `role: {_eq: X-Hasura-Role}` and Hasura substitutes the variable itself;
-- current_setting('hasura.user') is not reliably populated for the subquery a
-- permission check runs. 'guest' is not in e_player_roles and so has no row --
-- no row means the gate is not cleared.

DROP VIEW IF EXISTS "public"."v_role_permissions";

CREATE OR REPLACE VIEW "public"."v_role_permissions" AS
SELECT
    r.value AS role,
    public.is_role_below(
        COALESCE((SELECT s.value FROM public.settings s WHERE s.name = 'public.create_matches_role'), 'user'),
        r.value
    ) AS can_create_matches,
    public.is_role_below(
        COALESCE((SELECT s.value FROM public.settings s WHERE s.name = 'public.create_tournaments_role'), 'user'),
        r.value
    ) AS can_create_tournaments,
    public.is_role_below(
        COALESCE((SELECT s.value FROM public.settings s WHERE s.name = 'public.create_events_role'), 'user'),
        r.value
    ) AS can_create_events
FROM public.e_player_roles r;
