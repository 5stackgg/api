-- Crockford base32 over gen_random_bytes: 10 chars, 50 bits, no ambiguous
-- glyphs, 256 % 32 == 0 so the modulo is unbiased. The generator for any code
-- handed out on a public link.
--
-- 1885000000000_tournament_invite_codes seeds a copy when it is missing --
-- migrations run before this phase, so a column DEFAULT calling it would not
-- resolve on a fresh install. This file stays the definition that is maintained.
CREATE OR REPLACE FUNCTION public.generate_secure_invite_code() RETURNS text
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
