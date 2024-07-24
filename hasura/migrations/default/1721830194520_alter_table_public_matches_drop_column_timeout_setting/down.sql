alter table "public"."matches" alter column "timeout_setting" set default ''CoachAndPlayers'::text';
alter table "public"."matches"
  add constraint "matches_timeout_setting_fkey"
  foreign key (timeout_setting)
  references "public"."e_timeout_settings"
  (value) on update cascade on delete restrict;
alter table "public"."matches" alter column "timeout_setting" drop not null;
alter table "public"."matches" add column "timeout_setting" text;
