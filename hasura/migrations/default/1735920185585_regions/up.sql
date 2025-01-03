
alter table "public"."game_server_nodes" add column "use_lan_ip" boolean
 not null default 'false';

alter table "public"."servers" add column "is_lan" boolean
 not null default 'false';

alter table "public"."game_server_nodes" rename column "use_lan_ip" to "is_lan";

alter table "public"."e_server_regions" rename to "server_regions";

alter table "public"."server_regions" add column "is_lan" boolean
 not null default 'false';
