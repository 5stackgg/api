-- Free agents no longer sign up as a party. The triggers go first: the one
-- fired on UPDATE OF party_id depends on the column and blocks dropping it.
DROP TRIGGER IF EXISTS tadu_tournament_free_agents_party ON public.tournament_free_agents;
DROP TRIGGER IF EXISTS tbu_tournament_free_agents ON public.tournament_free_agents;

DROP FUNCTION IF EXISTS public.tadu_tournament_free_agents_party();
DROP FUNCTION IF EXISTS public.tbu_tournament_free_agents();
DROP FUNCTION IF EXISTS public.tournament_free_agent_party_fits(uuid, uuid, uuid);

DROP INDEX IF EXISTS public.idx_tournament_free_agents_party;

ALTER TABLE public.tournament_free_agents
    DROP COLUMN IF EXISTS party_id;

-- Only the lobby sign-up sent this. Its notifications go with the type through
-- the cascade on notifications_type_fkey.
DELETE FROM public.notification_preferences
 WHERE key = 'TournamentPartySignup';

DELETE FROM public.e_notification_types
 WHERE "value" = 'TournamentPartySignup';
