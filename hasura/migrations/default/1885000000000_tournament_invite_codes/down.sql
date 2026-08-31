ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS registration_passcode text;

DROP INDEX IF EXISTS public.idx_tournament_registration_unlocks_team;
DROP INDEX IF EXISTS public.idx_tournament_registration_unlocks_player;

ALTER TABLE public.tournament_registration_unlocks
    DROP CONSTRAINT IF EXISTS tournament_registration_unlocks_scoped_once;

DELETE FROM public.tournament_registration_unlocks WHERE player_steam_id IS NULL;

ALTER TABLE public.tournament_registration_unlocks
    DROP COLUMN IF EXISTS team_id;

ALTER TABLE public.tournament_registration_unlocks
    ALTER COLUMN player_steam_id SET NOT NULL;

ALTER TABLE public.tournament_registration_unlocks
    ADD CONSTRAINT tournament_registration_unlocks_pkey
        PRIMARY KEY (tournament_id, player_steam_id);

DROP INDEX IF EXISTS public.idx_tournament_invites_team_id;
DROP INDEX IF EXISTS public.idx_tournament_invites_team_unique;
DROP INDEX IF EXISTS public.idx_tournament_invites_player_unique;

ALTER TABLE public.tournament_invites
    DROP CONSTRAINT IF EXISTS tournament_invites_addressed_once;

DELETE FROM public.tournament_invites WHERE steam_id IS NULL;

ALTER TABLE public.tournament_invites
    DROP COLUMN IF EXISTS team_id;

ALTER TABLE public.tournament_invites
    ALTER COLUMN steam_id SET NOT NULL;

ALTER TABLE public.tournament_invites
    ADD CONSTRAINT tournament_invites_tournament_id_steam_id_key
        UNIQUE (tournament_id, steam_id);

DROP TABLE IF EXISTS public.tournament_invite_code_uses;
DROP TABLE IF EXISTS public.tournament_invite_codes;

CREATE OR REPLACE FUNCTION public.generate_utility_invite_code() RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    AS $fn$
DECLARE
    alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    source bytea := gen_random_bytes(10);
    code text := '';
    i int;
BEGIN
    FOR i IN 0..9 LOOP
        code := code || substr(alphabet, (get_byte(source, i) % 32) + 1, 1);
    END LOOP;
    RETURN code;
END;
$fn$;

DROP FUNCTION IF EXISTS public.generate_secure_invite_code();
