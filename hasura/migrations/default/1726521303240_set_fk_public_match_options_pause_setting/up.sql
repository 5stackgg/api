alter table "public"."match_options" drop constraint "match_options_pause_setting_fkey",
  add constraint "match_options_pause_setting_fkey"
  foreign key ("pause_setting")
  references "public"."e_timeout_settings"
  ("value") on update cascade on delete cascade;
