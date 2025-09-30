alter table "public"."team_roster" add column if not exists "status" text
 not null default 'Starter';

alter table "public"."team_roster" add column if not exists "coach" boolean
 not null default 'false';

create table if not exists "public"."e_team_roster_statuses" (
    value text not null,
    description text not null,
    primary key (value)
);


insert into e_team_roster_statuses ("value", "description") values
    ('Starter', 'Starter'),
    ('Substitute', 'Substitute'),
    ('Benched', 'Benched')
on conflict(value) do update set "description" = EXCLUDED."description"

alter table "public"."team_roster"
  add constraint "team_roster_status_fkey"
  foreign key ("status")
  references "public"."e_team_roster_statuses"
  ("value") on update cascade on delete restrict;
