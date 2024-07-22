alter table "public"."tournament_servers" drop constraint "tournament_servers_pkey";
alter table "public"."tournament_servers"
    add constraint "tournament_servers_pkey"
    primary key ("id");
