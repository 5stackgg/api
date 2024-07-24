alter table "public"."matches"
  add constraint "matches_match_options_id_fkey"
  foreign key ("match_options_id")
  references "public"."match_options"
  ("id") on update cascade on delete restrict;
