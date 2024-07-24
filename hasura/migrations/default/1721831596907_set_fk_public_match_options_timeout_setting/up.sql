alter table "public"."match_options"
  add constraint "match_options_timeout_setting_fkey"
  foreign key ("timeout_setting")
  references "public"."e_timeout_settings"
  ("value") on update cascade on delete restrict;
