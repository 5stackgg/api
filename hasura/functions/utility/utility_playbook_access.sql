-- Visibility/edit access for team playbooks. Same shape as the lineup and
-- collection primitives in utility_access.sql, and deliberately built on the same
-- is_utility_team_member / is_utility_team_admin helpers so a team's book, its
-- lineups and its executes can never disagree about who is on the team.

-- LANGUAGE plpgsql: bodies are not parsed for object references at CREATE
-- time, so these resolve regardless of the order hasura/functions is applied
-- in on a fresh install.
CREATE OR REPLACE FUNCTION public.can_view_utility_playbook(
    playbook public.utility_playbooks,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
BEGIN
    IF hasura_session ->> 'x-hasura-role'
        IN ('admin', 'administrator', 'moderator') THEN
        RETURN true;
    END IF;

    IF playbook.visibility = 'Public' THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF playbook.owner_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    IF playbook.visibility = 'Team' THEN
        RETURN public.is_utility_team_member(playbook.team_id, _steam_id);
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_edit_utility_playbook(
    playbook public.utility_playbooks,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
BEGIN
    IF hasura_session ->> 'x-hasura-role'
        IN ('admin', 'administrator', 'moderator') THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF playbook.owner_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    -- An execute is the team's, not the one player's who typed it in: a team
    -- admin can rewrite a book whose author has stopped maintaining it.
    IF playbook.visibility = 'Team' THEN
        RETURN public.is_utility_team_admin(playbook.team_id, _steam_id);
    END IF;

    RETURN false;
END;
$$;
