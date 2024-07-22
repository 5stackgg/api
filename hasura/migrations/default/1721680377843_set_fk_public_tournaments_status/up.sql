alter table "public"."tournaments"
  add constraint "tournaments_status_fkey"
  foreign key ("status")
  references "public"."e_tournament_status"
  ("value") on update cascade on delete restrict;
