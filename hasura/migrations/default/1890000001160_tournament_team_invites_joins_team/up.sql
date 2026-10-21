-- An invite onto a team-backed entry either joins the player to the team or
-- seats them as a stand-in, and which one is fixed when it is sent so the
-- player knows what they are accepting. Invites already out never said they
-- joined a team.
alter table "public"."tournament_team_invites"
    add column if not exists "joins_team" boolean not null default false;
