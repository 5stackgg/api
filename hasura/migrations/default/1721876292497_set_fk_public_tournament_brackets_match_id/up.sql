alter table "public"."tournament_brackets"
  add constraint "tournament_brackets_match_id_fkey"
  foreign key ("match_id")
  references "public"."matches"
  ("id") on update cascade on delete restrict;
