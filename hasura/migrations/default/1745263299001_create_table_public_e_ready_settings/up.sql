CREATE TABLE "public"."e_ready_settings" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

alter table "public"."match_options" add column "ready_setting" text
 not null default 'Players';

alter table "public"."match_options"
  add constraint "match_options_ready_setting_fkey"
  foreign key ("ready_setting")
  references "public"."e_ready_settings"
  ("value") on update cascade on delete restrict;
