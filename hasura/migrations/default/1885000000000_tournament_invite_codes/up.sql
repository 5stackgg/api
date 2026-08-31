-- Crockford base32 over gen_random_bytes: 10 chars, 50 bits, no ambiguous
-- glyphs, 256 % 32 == 0 so the modulo is unbiased. It arrived with the utility
-- practice sessions and is the right algorithm for any link handed out in
-- public, so it moves here and generate_utility_invite_code() delegates -- its
-- name and signature are untouched, which is what keeps the
-- utility_practice_sessions.invite_code default working.
--
-- This has to be a migration rather than a hasura/functions file: migrations run
-- before the functions phase, so the tournament_invite_codes.code DEFAULT below
-- would not resolve on a fresh install. 1880000000000_utility_lineups documents
-- the same trap for generate_invite_code().
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

CREATE OR REPLACE FUNCTION public.generate_utility_invite_code() RETURNS text
    LANGUAGE sql
    VOLATILE
    AS $fn$
    SELECT public.generate_secure_invite_code();
$fn$;


-- A tournament is advertised for weeks, so its way in cannot be a static
-- secret that never expires. A code expires, caps its uses, can be revoked, and
-- records who used it.
CREATE TABLE IF NOT EXISTS public.tournament_invite_codes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    code text NOT NULL DEFAULT public.generate_secure_invite_code(),

    -- NULL is "never expires" / "unlimited" rather than a sentinel date or
    -- count that every reader has to remember not to compare against.
    expires_at timestamptz,
    max_uses integer,

    uses integer NOT NULL DEFAULT 0,
    revoked_at timestamptz,
    created_by_player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),

    -- Deliberately not partial. A revoked code staying reserved forever is the
    -- safe failure, and the alternative is not available anyway: an index
    -- predicate over now() is impossible because now() is not immutable.
    UNIQUE (code),

    CONSTRAINT tournament_invite_codes_max_uses_positive
        CHECK (max_uses IS NULL OR max_uses > 0),
    CONSTRAINT tournament_invite_codes_uses_not_negative
        CHECK (uses >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tournament_invite_codes_tournament
    ON public.tournament_invite_codes (tournament_id);


-- "See who used it": the organizer's audit of a link they published.
CREATE TABLE IF NOT EXISTS public.tournament_invite_code_uses (
    invite_code_id uuid NOT NULL REFERENCES public.tournament_invite_codes (id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,

    -- Which team they brought, once they bring one. A redemption grants entry
    -- to the player, so this is NULL at the moment the code is spent.
    team_id uuid REFERENCES public.teams (id) ON UPDATE CASCADE ON DELETE SET NULL,

    used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (invite_code_id, player_steam_id)
);


-- Tournaments recruit teams, not only players. One table rather than a sibling:
-- a tournament_team_invite* name would collide with tournament_team_invites,
-- which already means "join a team that is registered".
ALTER TABLE public.tournament_invites
    ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams (id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.tournament_invites
    ALTER COLUMN steam_id DROP NOT NULL;

ALTER TABLE public.tournament_invites
    DROP CONSTRAINT IF EXISTS tournament_invites_tournament_id_steam_id_key;

ALTER TABLE public.tournament_invites
    DROP CONSTRAINT IF EXISTS tournament_invites_addressed_once;

ALTER TABLE public.tournament_invites
    ADD CONSTRAINT tournament_invites_addressed_once
        CHECK (num_nonnulls(steam_id, team_id) = 1);

-- The plain UNIQUE (tournament_id, steam_id) stops deduping the moment steam_id
-- can be NULL -- every NULL is distinct to a unique index, so a table of team
-- invites would all be "unique" on the player half. Two partial indexes instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_invites_player_unique
    ON public.tournament_invites (tournament_id, steam_id)
    WHERE steam_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_invites_team_unique
    ON public.tournament_invites (tournament_id, team_id)
    WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tournament_invites_team_id
    ON public.tournament_invites (team_id);


-- An unlock is now either player-scoped or team-scoped, on the same shape as
-- the invite that grants it. A team-scoped row carries no player: it is the
-- team that was let in, and whoever may register that team inherits it.
ALTER TABLE public.tournament_registration_unlocks
    ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams (id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Before the DROP NOT NULL, not after: a column still in a primary key cannot
-- become nullable.
ALTER TABLE public.tournament_registration_unlocks
    DROP CONSTRAINT IF EXISTS tournament_registration_unlocks_pkey;

ALTER TABLE public.tournament_registration_unlocks
    ALTER COLUMN player_steam_id DROP NOT NULL;

ALTER TABLE public.tournament_registration_unlocks
    DROP CONSTRAINT IF EXISTS tournament_registration_unlocks_scoped_once;

ALTER TABLE public.tournament_registration_unlocks
    ADD CONSTRAINT tournament_registration_unlocks_scoped_once
        CHECK (num_nonnulls(player_steam_id, team_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_registration_unlocks_player
    ON public.tournament_registration_unlocks (tournament_id, player_steam_id)
    WHERE team_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_registration_unlocks_team
    ON public.tournament_registration_unlocks (tournament_id, team_id)
    WHERE team_id IS NOT NULL;


-- Its own step, and the irreversible one: everything above works without it.
-- The typed passcode is a bearer secret that never expires, and it had a trap
-- of its own -- invite_only saved with a NULL passcode locked everyone out with
-- no UI path back. The generated codes replace it outright.
--
-- The computed field goes with the column: a SQL function body is a string, so
-- Postgres tracks no dependency and would leave it to fail at call time instead.
DROP FUNCTION IF EXISTS public.tournament_organizer_registration_passcode(public.tournaments, json);

ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS registration_passcode;
