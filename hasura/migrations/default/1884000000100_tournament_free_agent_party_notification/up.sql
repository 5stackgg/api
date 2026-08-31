INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('TournamentPartySignup', 'Your lobby was signed up for a tournament as a free agent party')
ON CONFLICT ("value") DO UPDATE
    SET "description" = EXCLUDED."description";
