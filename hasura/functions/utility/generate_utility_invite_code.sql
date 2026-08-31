-- Kept as its own name and signature because utility_practice_sessions.invite_code
-- defaults to it; the algorithm itself lives in generate_secure_invite_code().
CREATE OR REPLACE FUNCTION public.generate_utility_invite_code() RETURNS text
    LANGUAGE sql
    VOLATILE
    AS $fn$
    SELECT public.generate_secure_invite_code();
$fn$;
