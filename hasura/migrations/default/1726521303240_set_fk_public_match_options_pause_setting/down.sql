alter table "public"."match_options" drop constraint "match_options_pause_setting_fkey",
  add constraint "match_options_pause_setting_fkey"
  foreign key ("type")
  references "public"."e_match_types"
  ("value") on update cascade on delete restrict;
