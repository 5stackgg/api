alter table "public"."tournament_stages"
  add constraint "tournament_stages_type_fkey"
  foreign key ("type")
  references "public"."e_tournament_stage_types"
  ("value") on update cascade on delete restrict;
