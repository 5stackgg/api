-- Fills one vacated slot on a drafted pickup team from the waitlist. Returns the
-- promoted player's steam id, or NULL when nothing was promoted.
--
-- Waitlisting used to be a one-way door: a drafted free agent who left took
-- their team below min_players_per_lineup, the team was dropped at seeding, and
-- the waitlisted players sat there while the bracket shrank.
--
-- SIGN-UP ORDER DECIDES, exactly like the draft's selection stage -- created_at
-- ascending, never ELO. The draft only lets ELO decide which team a selected
-- player lands on; letting it decide who plays at all is the one thing a
-- first-come pool must not do, and a promotion is a selection.
CREATE OR REPLACE FUNCTION public.promote_tournament_free_agent(
    _tournament_id uuid,
    _tournament_team_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _promoted public.tournament_free_agents;
    _team_size int;
    _roster_count int;
    _check_in_closed boolean;
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

    -- Idempotent: only a team actually short of a lineup has a slot on offer, so
    -- re-running against a full team promotes nobody rather than over-filling it.
    IF _roster_count >= _team_size THEN
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

    SELECT fa.* INTO _promoted
    FROM public.tournament_free_agents fa
    WHERE fa.tournament_id = _tournament_id
      AND fa.status = 'waitlisted'
      AND (NOT _check_in_closed OR fa.checked_in_at IS NOT NULL)
      AND public.player_meets_tournament_requirements(_tournament_id, fa.player_steam_id)
      -- Already playing, under either identity. The roster key is unique per
      -- (tournament, player) so the insert below would abort the caller's whole
      -- statement, and owning a team collides with
      -- UNIQUE (owner_steam_id, tournament_id) -- the collision that hard-stalled
      -- the draft once already.
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
    ORDER BY fa.created_at, fa.id
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

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
    VALUES (
        _tournament_team_id, _promoted.player_steam_id, _tournament_id, 'Member', _promoted.checked_in_at
    );

    UPDATE public.tournament_free_agents fa
       SET status = 'drafted',
           tournament_team_id = _tournament_team_id
     WHERE fa.id = _promoted.id;

    PERFORM set_config('fivestack.free_agent_draft', 'false', true);

    RETURN _promoted.player_steam_id;
END;
$$;
