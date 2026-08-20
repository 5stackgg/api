-- How close the crosshair has to be before a lineup counts as lined up, in
-- degrees. Per lineup rather than one constant, because a wall-bang smoke and
-- a lobbed molotov do not need the same precision: a tight one wants a green
-- zone you can only reach deliberately, a forgiving one wants a green zone you
-- can find at a glance.
ALTER TABLE public.utility_lineups
    ADD COLUMN aim_tolerance double precision NOT NULL DEFAULT 0.35;

ALTER TABLE public.utility_lineups
    ADD CONSTRAINT utility_lineups_aim_tolerance_sane
    CHECK (aim_tolerance > 0 AND aim_tolerance <= 15);
