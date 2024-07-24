alter table "public"."matches" alter column "tech_timeout_setting" set default ''CoachAndPlayers'::text';
alter table "public"."matches"
  add constraint "matches_tech_timeout_setting_fkey"
  foreign key (tech_timeout_setting)
  references "public"."e_timeout_settings"
  (value) on update cascade on delete restrict;
alter table "public"."matches" alter column "tech_timeout_setting" drop not null;
alter table "public"."matches" add column "tech_timeout_setting" text;
