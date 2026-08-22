-- Who may join a practice server, replacing an is_open boolean that could only
-- say "anyone" or "anyone the host knows". The four values mirror
-- e_lobby_access exactly, because a practice server and a match lobby are the
-- same question asked twice and the UI already teaches one vocabulary.
CREATE TABLE IF NOT EXISTS public.e_utility_practice_access (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_utility_practice_access (value, description)
VALUES
    ('Open', 'Anyone with the link can join'),
    ('Friends', 'Friends of the host, their team, and invited players'),
    ('Invite', 'Only invited players and the host''s team'),
    ('Private', 'Only the host')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

ALTER TABLE public.utility_practice_sessions
    ADD COLUMN IF NOT EXISTS access text NOT NULL DEFAULT 'Friends';

DO $$
BEGIN
    ALTER TABLE public.utility_practice_sessions
        ADD CONSTRAINT utility_practice_sessions_access_fkey
        FOREIGN KEY (access) REFERENCES public.e_utility_practice_access (value)
        ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

-- Closed used to mean "friends, team and invitees" rather than invite-only, so
-- that is what a closed session becomes -- not Invite, which would silently
-- lock people out of servers they could reach yesterday.
UPDATE public.utility_practice_sessions
   SET access = CASE WHEN is_open THEN 'Open' ELSE 'Friends' END
 WHERE access = 'Friends';

CREATE INDEX IF NOT EXISTS utility_practice_sessions_access_idx
    ON public.utility_practice_sessions (access);
