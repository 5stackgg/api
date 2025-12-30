update "public"."tournament_teams" set seed = null where seed is not null;

alter table "public"."tournament_teams" add constraint "tournament_teams_tournament_id_seed_key" unique ("tournament_id", "seed");
