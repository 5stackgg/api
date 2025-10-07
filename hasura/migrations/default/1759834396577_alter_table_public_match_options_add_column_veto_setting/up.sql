alter table "public"."match_options" add column if not exists "check_in_setting" text
 not null default 'Players';

create table if not exists "public"."e_check_in_settings" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

insert into e_check_in_settings ("value", "description") values
    ('Players', 'All Players'),
    ('Captains', 'Captains Only'),
    ('Admin', 'Admins Only')
on conflict(value) do update set "description" = EXCLUDED."description";

alter table "public"."match_options" add constraint "match_options_check_in_setting_fkey" foreign key ("check_in_setting") references "public"."e_check_in_settings" ("value") on update cascade on delete restrict;