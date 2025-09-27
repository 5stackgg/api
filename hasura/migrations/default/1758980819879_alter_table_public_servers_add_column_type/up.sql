alter table "public"."servers" add column if not exists "type" Text
 not null default 'Ranked';

alter table "public"."servers" add column if not exists "is_dedicated" boolean
 not null default 'false';

alter table "public"."servers" add column if not exists "connect_password" text null;
alter table "public"."servers" add column if not exists "max_players" integer null default 32;

update "public"."servers" set "is_dedicated" = true where "game_server_node_id" is null;

CREATE TABLE if not exists public.e_server_types (
    value text PRIMARY KEY,
    description text NOT NULL
);

insert into e_server_types ("value", "description") values
    ('Ranked', 'Ranked'),
    ('Deathmatch', 'Deathmatch'),
    ('Retake', 'Retake'),
    ('Aim', 'Aim'),
    ('Custom', 'Custom')
on conflict(value) do update set "description" = EXCLUDED."description"

alter table "public"."servers"
  add constraint "servers_type_fkey"
  foreign key ("type")
  references "public"."e_server_types"
  ("value") on update cascade on delete restrict;

drop function if exists public.is_dedicated_server;
