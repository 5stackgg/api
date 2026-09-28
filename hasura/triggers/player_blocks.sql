-- Blocking twice is a no-op rather than a constraint error: Hasura only exposes
-- on_conflict to a role that also has an update permission, and this table
-- deliberately has none.
CREATE OR REPLACE FUNCTION public.tbi_player_blocks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.player_blocks pb
        WHERE pb.blocker_steam_id = NEW.blocker_steam_id
          AND pb.blocked_steam_id = NEW.blocked_steam_id
    ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_player_blocks ON public.player_blocks;
CREATE TRIGGER tbi_player_blocks BEFORE INSERT ON public.player_blocks FOR EACH ROW EXECUTE FUNCTION public.tbi_player_blocks();

-- Everything pending between the pair goes, in both directions, so neither side
-- is left holding a way to reach the other. The friendship goes too: it is what
-- grants DMs and a view into Friends-only lobbies and drafts. Unblocking restores
-- none of it.
--
-- Only the blocker's own bell entries and DM rail change. A cancelled invite
-- leaves the invitee's bell alone, so retracting theirs would single out a block.
CREATE OR REPLACE FUNCTION public.tai_player_blocks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _a bigint := NEW.blocker_steam_id;
    _b bigint := NEW.blocked_steam_id;
BEGIN
    DELETE FROM public.friends f
    WHERE (f.player_steam_id = _a AND f.other_player_steam_id = _b)
       OR (f.player_steam_id = _b AND f.other_player_steam_id = _a);

    DELETE FROM public.lobby_players lp
    WHERE lp.status = 'Invited'
      AND ((lp.steam_id = _a AND lp.invited_by_steam_id = _b)
        OR (lp.steam_id = _b AND lp.invited_by_steam_id = _a));

    WITH gone AS (
        DELETE FROM public.team_invites ti
        WHERE (ti.steam_id = _a AND ti.invited_by_player_steam_id = _b)
           OR (ti.steam_id = _b AND ti.invited_by_player_steam_id = _a)
        RETURNING ti.id
    )
    UPDATE public.notifications n
       SET deleted_at = now()
     WHERE n.entity_id IN (SELECT id::text FROM gone)
       AND n.type = 'TeamInvite'
       AND n.steam_id = _a
       AND n.deleted_at IS NULL;

    WITH gone AS (
        DELETE FROM public.tournament_team_invites tti
        WHERE (tti.steam_id = _a AND tti.invited_by_player_steam_id = _b)
           OR (tti.steam_id = _b AND tti.invited_by_player_steam_id = _a)
        RETURNING tti.id
    )
    UPDATE public.notifications n
       SET deleted_at = now()
     WHERE n.entity_id IN (SELECT id::text FROM gone)
       AND n.type = 'TournamentTeamInvite'
       AND n.steam_id = _a
       AND n.deleted_at IS NULL;

    WITH gone AS (
        DELETE FROM public.tournament_invites ti
        WHERE (ti.steam_id = _a AND ti.invited_by_player_steam_id = _b)
           OR (ti.steam_id = _b AND ti.invited_by_player_steam_id = _a)
        RETURNING ti.id
    )
    UPDATE public.notifications n
       SET deleted_at = now()
     WHERE n.entity_id IN (SELECT id::text FROM gone)
       AND n.type = 'TournamentInvite'
       AND n.steam_id = _a
       AND n.deleted_at IS NULL;

    -- A draft invite records no inviter, and the notification is keyed on the
    -- draft rather than the row, so the host stands in for whoever sent it.
    WITH gone AS (
        DELETE FROM public.draft_game_players dgp
        USING public.draft_games g
        WHERE dgp.draft_game_id = g.id
          AND dgp.status = 'Invited'
          AND ((dgp.steam_id = _a AND g.host_steam_id = _b)
            OR (dgp.steam_id = _b AND g.host_steam_id = _a))
        RETURNING dgp.draft_game_id, dgp.steam_id
    )
    UPDATE public.notifications n
       SET deleted_at = now()
      FROM gone
     WHERE n.entity_id = gone.draft_game_id::text
       AND n.steam_id = gone.steam_id
       AND n.type = 'DraftInvite'
       AND n.steam_id = _a
       AND n.deleted_at IS NULL;

    WITH gone AS (
        DELETE FROM public.utility_practice_invites i
        USING public.utility_practice_sessions s
        WHERE s.id = i.utility_practice_session_id
          AND ((i.steam_id = _a AND (i.invited_by_steam_id = _b OR s.host_steam_id = _b))
            OR (i.steam_id = _b AND (i.invited_by_steam_id = _a OR s.host_steam_id = _a)))
        RETURNING i.utility_practice_session_id, i.steam_id
    )
    UPDATE public.notifications n
       SET deleted_at = now()
      FROM gone
     WHERE n.entity_id = gone.utility_practice_session_id::text
       AND n.steam_id = gone.steam_id
       AND n.type = 'UtilityPracticeInvite'
       AND n.steam_id = _a
       AND n.deleted_at IS NULL;

    -- The room id must match directRoomId() in src/chat.
    UPDATE public.direct_conversations dc
       SET is_open = false
     WHERE dc.room_id = LEAST(_a, _b)::text || ':' || GREATEST(_a, _b)::text
       AND dc.steam_id = _a;

    -- Chat hides what the blocked player said from the blocker, so their bell
    -- previews go the way NotificationsService.retractChatMessage takes them:
    -- blanked as well, since a recipient can restore their own deleted rows,
    -- and a push still waiting in its bundling window skips a deleted row.
    UPDATE public.notifications n
       SET deleted_at = COALESCE(n.deleted_at, now()),
           message = ''
     WHERE n.steam_id = _a
       AND n.type IN ('ChatMessage', 'MatchChatMessage')
       AND n.data->>'senderSteamId' = _b::text
       AND (n.deleted_at IS NULL OR n.message <> '');

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_blocks ON public.player_blocks;
CREATE TRIGGER tai_player_blocks AFTER INSERT ON public.player_blocks FOR EACH ROW EXECUTE FUNCTION public.tai_player_blocks();

-- Organizer rosters that take a player with no invite or consent.
DROP TRIGGER IF EXISTS tbi_event_players_not_blocked ON public.event_players;
CREATE TRIGGER tbi_event_players_not_blocked BEFORE INSERT ON public.event_players
    FOR EACH ROW EXECUTE FUNCTION public.tbi_assert_session_not_blocked('steam_id', 'tournament_organizer');

DROP TRIGGER IF EXISTS tbi_event_organizers_not_blocked ON public.event_organizers;
CREATE TRIGGER tbi_event_organizers_not_blocked BEFORE INSERT ON public.event_organizers
    FOR EACH ROW EXECUTE FUNCTION public.tbi_assert_session_not_blocked('steam_id', 'tournament_organizer');

DROP TRIGGER IF EXISTS tbi_tournament_organizers_not_blocked ON public.tournament_organizers;
CREATE TRIGGER tbi_tournament_organizers_not_blocked BEFORE INSERT ON public.tournament_organizers
    FOR EACH ROW EXECUTE FUNCTION public.tbi_assert_session_not_blocked('steam_id', 'tournament_organizer');
