alter table "public"."match_options"
  add constraint "match_options_tech_timeout_setting_fkey"
  foreign key ("tech_timeout_setting")
  references "public"."e_timeout_settings"
  ("value") on update cascade on delete restrict;
