-- A party is the set of free agents in one tournament sharing a party_id: the
-- id of the 5stack lobby they signed up from. Membership of that lobby is the
-- consent -- the lobby captain already queues the whole lobby into matchmaking,
-- so signing the same lobby up for a draft needs no second mechanism.

-- Caps a party at the tournament's team size. The draft places a party on ONE
-- team, so a party that cannot fit a team could never be honoured: it would sit
-- in the pool being skipped by every draft forever while its members believed
-- they were entered.
--
-- _agent_id is excluded from the count so an UPDATE that only moves a row
-- between parties is not measured against itself.
CREATE OR REPLACE FUNCTION public.tournament_free_agent_party_fits(
    _tournament_id uuid,
    _party_id uuid,
    _agent_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _tournament public.tournaments;
    _team_size int;
    _party_size int;
BEGIN
    IF _party_id IS NULL THEN
        RETURN true;
    END IF;

    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN true;
    END IF;

    _team_size := COALESCE(
        public.tournament_min_players_per_lineup(_tournament),
        public.tournament_max_players_per_lineup(_tournament)
    );

    -- A format with no lineup size has no cap to enforce; the draft refuses to
    -- run on one anyway.
    IF _team_size IS NULL OR _team_size < 1 THEN
        RETURN true;
    END IF;

    SELECT COUNT(*) INTO _party_size
    FROM public.tournament_free_agents fa
    WHERE fa.tournament_id = _tournament_id
      AND fa.party_id = _party_id
      AND fa.status <> 'withdrawn'
      AND fa.id IS DISTINCT FROM _agent_id;

    RETURN _party_size + 1 <= _team_size;
END;
$$;
