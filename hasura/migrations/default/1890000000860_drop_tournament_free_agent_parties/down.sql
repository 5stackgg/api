INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('TournamentPartySignup', 'Your lobby was signed up for a tournament as a free agent party')
ON CONFLICT ("value") DO NOTHING;

ALTER TABLE public.tournament_free_agents
    ADD COLUMN IF NOT EXISTS party_id uuid;

CREATE INDEX IF NOT EXISTS idx_tournament_free_agents_party
    ON public.tournament_free_agents (tournament_id, party_id)
    WHERE party_id IS NOT NULL;
