CREATE TABLE IF NOT EXISTS "public"."e_ready_settings" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

insert into e_ready_settings ("value", "description") values
    ('Players', 'All Players'),
    ('Captains', 'Captains Only'),
    ('Coach', 'Coach Only'),
    ('Admin', 'Admins Only')
on conflict(value) do update set "description" = EXCLUDED."description";
 
alter table "public"."match_options" add column if not exists "ready_setting" text
 not null default 'Players';

alter table "public"."match_options"
  add constraint "match_options_ready_setting_fkey"
  foreign key ("ready_setting")
  references "public"."e_ready_settings"
  ("value") on update cascade on delete restrict;
