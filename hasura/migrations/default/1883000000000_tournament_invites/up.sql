-- The missing half of invite_only. Before this, "invite only" meant
-- "passcode only": tournament_registration_unlocks was reachable through
-- unlockTournamentRegistration alone, so an organizer who never handed out a
-- code locked everyone out and had no way to let anyone in.
--
-- Keyed on steam_id rather than on a team, like every other invite table on the
-- platform: the invite has to work whether the player brings a registered team
-- or enters the free-agent pool.
CREATE TABLE IF NOT EXISTS public.tournament_invites (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    invited_by_player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (tournament_id, steam_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_invites_steam_id
    ON public.tournament_invites (steam_id);

-- Repeated in hasura/enums/notification-types.sql; enums are applied after
-- migrations, so both exist on purpose. The notification specs scrape every
-- quoted value-then-description pair out of any up.sql that mentions
-- e_notification_types and treat it as a notification type -- nothing else in
-- this file has that shape, so the table DDL above can share the migration.
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('TournamentInvite', 'You were invited to register for a tournament')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";
