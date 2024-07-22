alter table "public"."tournament_team_roster" drop constraint "tournament_team_roster_pkey";
alter table "public"."tournament_team_roster"
    add constraint "tournament_roster_pkey"
    primary key ("player_steam_id", "id");
