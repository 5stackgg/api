-- Fills the vacated slots on a drafted pickup team from the waitlist. Returns
-- the promoted players' steam ids, or NULL when nothing was promoted.
--
-- Waitlisting used to be a one-way door: a drafted free agent who left took
-- their team below min_players_per_lineup, the team was dropped at seeding, and
-- the waitlisted players sat there while the bracket shrank.
--
-- SIGN-UP ORDER DECIDES, exactly like the draft's selection stage -- created_at
-- ascending, never ELO. The draft only lets ELO decide which team a selected
-- player lands on; letting it decide who plays at all is the one thing a
-- first-come pool must not do, and a promotion is a selection.
--
-- Returns an array rather than one id because the waitlist is made of UNITS: a
-- party promotes whole or not at all, so one call can fill more than one slot.
DROP FUNCTION IF EXISTS public.promote_tournament_free_agent(uuid, uuid);

CREATE OR REPLACE FUNCTION public.promote_tournament_free_agent(
    _tournament_id uuid,
    _tournament_team_id uuid
)
RETURNS bigint[]
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _team_size int;
    _roster_count int;
    _free_slots int;
    _check_in_closed boolean;
    _promoted_ids uuid[];
    _promoted bigint[];
BEGIN
    IF _tournament_id IS NULL OR _tournament_team_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF _tournament.registration_type = 'teams' THEN
        RETURN NULL;
    END IF;

    -- Once the bracket is in play the seeds are drawn, servers are being
    -- reserved and lineups are already built from the roster as it stands.
    -- Swapping a stranger in mid-tournament is a different, riskier feature.
    IF _tournament.status NOT IN ('Setup', 'RegistrationOpen', 'RegistrationClosed', 'CheckInReview') THEN
        RETURN NULL;
    END IF;

    -- Serializes the pick-then-write against another departure on the same
    -- tournament. Without it two simultaneous leaves both read the waitlist
    -- before either writes, and both promote the same player -- one of them
    -- into a unique-key violation that rolls a legitimate departure back.
    -- Transaction scoped, so it is released with the commit either way.
    PERFORM pg_advisory_xact_lock(
        hashtext('tournament_free_agent_promotion'),
        hashtext(_tournament_id::text)
    );

    -- The team may already be gone: deleting a tournament_teams row cascades
    -- into its roster, and the parent is removed before the children, so this
    -- runs with no slot left to fill.
    IF NOT EXISTS (
        SELECT 1 FROM public.tournament_teams tt
        WHERE tt.id = _tournament_team_id AND tt.tournament_id = _tournament_id
    ) THEN
        RETURN NULL;
    END IF;

    _team_size := COALESCE(
        public.tournament_min_players_per_lineup(_tournament),
        public.tournament_max_players_per_lineup(_tournament)
    );

    IF _team_size IS NULL OR _team_size < 1 THEN
        RETURN NULL;
    END IF;

    SELECT COUNT(*) INTO _roster_count
    FROM public.tournament_team_roster ttr
    WHERE ttr.tournament_team_id = _tournament_team_id;

    _free_slots := _team_size - _roster_count;

    -- Idempotent: only a team actually short of a lineup has a slot on offer, so
    -- re-running against a full team promotes nobody rather than over-filling it.
    IF _free_slots < 1 THEN
        RETURN NULL;
    END IF;

    -- Stricter than "not ahead of someone who did check in": once the window has
    -- closed a waitlisted no-show is not eligible at all, which is the same rule
    -- the draft's own pool applies. Promoting someone who never confirmed puts a
    -- player who is not there into a match, and the close pass has already
    -- waitlisted every free agent who missed the prompt.
    _check_in_closed := _tournament.check_in_required
        AND public.tournament_check_in_window_opened(_tournament)
        AND NOT public.tournament_check_in_open(_tournament);

    WITH eligible AS (
        SELECT fa.id,
               fa.created_at,
               COALESCE(fa.party_id::text, 'solo:' || fa.id::text) AS unit_key
          FROM public.tournament_free_agents fa
         WHERE fa.tournament_id = _tournament_id
           AND fa.status = 'waitlisted'
           AND (NOT _check_in_closed OR fa.checked_in_at IS NOT NULL)
           AND public.player_meets_tournament_requirements(_tournament_id, fa.player_steam_id)
           -- Already playing, under either identity. The roster key is unique per
           -- (tournament, player) so the insert below would abort the caller's whole
           -- statement, and owning a team collides with
           -- UNIQUE (owner_steam_id, tournament_id) -- the collision that hard-stalled
           -- the draft once already. Per member: an ineligible member shrinks
           -- their party, it does not disqualify the party.
           AND NOT EXISTS (
               SELECT 1 FROM public.tournament_team_roster ttr
               WHERE ttr.tournament_id = _tournament_id
                 AND ttr.player_steam_id = fa.player_steam_id
           )
           AND NOT EXISTS (
               SELECT 1 FROM public.tournament_teams tt
               WHERE tt.tournament_id = _tournament_id
                 AND tt.owner_steam_id = fa.player_steam_id
           )
    ),
    units AS (
        SELECT e.unit_key,
               COUNT(*)::int AS size,
               MIN(e.created_at) AS first_at,
               MIN(e.id::text) AS first_id
          FROM eligible e
         GROUP BY e.unit_key
    ),
    -- Units that fit the gap whole come first (false sorts before true), and
    -- within each group the earliest signup wins. A solo is a unit of one, so a
    -- single vacancy naturally goes to the earliest solo ahead of any party.
    --
    -- The second group is the deliberate compromise: when EVERY waitlisted unit
    -- is a party too big for the gap, the earliest party is split and its
    -- earliest members take the slots. Splitting a party is bad; leaving the
    -- slot empty is worse for that same party, because a team below the minimum
    -- lineup is cut at seeding and the whole bracket they are waiting on
    -- shrinks. The members left behind keep their party_id, so they stay one
    -- unit with their original priority and are first in line for the next gap.
    pick AS (
        SELECT u.unit_key
          FROM units u
         ORDER BY (u.size > _free_slots), u.first_at, u.first_id
         LIMIT 1
    )
    SELECT array_agg(e.id ORDER BY e.created_at, e.id)
      INTO _promoted_ids
      FROM eligible e
      JOIN pick p ON p.unit_key = e.unit_key;

    IF _promoted_ids IS NULL THEN
        RETURN NULL;
    END IF;

    _promoted_ids := _promoted_ids[1:_free_slots];

    -- tbi_tournament_team_roster redirects a non-organizer insert on a pickup
    -- team into an INVITE nobody sent; the same GUC the draft uses marks this as
    -- the system path. Transaction local, so an error rolls it back.
    PERFORM set_config('fivestack.free_agent_draft', 'true', true);

    -- Their own confirmation carries over rather than being re-asked for: in
    -- Players mode the team-level rollup counts roster rows, and a promoted
    -- player who checked in as a free agent has already done what was asked.
    INSERT INTO public.tournament_team_roster (
        tournament_team_id, player_steam_id, tournament_id, role, checked_in_at
    )
    SELECT _tournament_team_id, fa.player_steam_id, _tournament_id, 'Member', fa.checked_in_at
      FROM public.tournament_free_agents fa
     WHERE fa.id = ANY(_promoted_ids);

    UPDATE public.tournament_free_agents fa
       SET status = 'drafted',
           tournament_team_id = _tournament_team_id
     WHERE fa.id = ANY(_promoted_ids);

    SELECT array_agg(fa.player_steam_id ORDER BY fa.created_at, fa.id)
      INTO _promoted
      FROM public.tournament_free_agents fa
     WHERE fa.id = ANY(_promoted_ids);

    PERFORM set_config('fivestack.free_agent_draft', 'false', true);

    RETURN _promoted;
END;
$$;
