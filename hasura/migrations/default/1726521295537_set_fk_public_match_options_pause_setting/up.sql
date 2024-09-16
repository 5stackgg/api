alter table "public"."match_options"
  add constraint "match_options_pause_setting_fkey"
  foreign key ("pause_setting")
  references "public"."e_timeout_settings"
  ("value") on update restrict on delete restrict;
