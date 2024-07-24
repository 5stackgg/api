alter table "public"."match_options"
  add constraint "match_options_type_fkey"
  foreign key ("type")
  references "public"."e_match_types"
  ("value") on update cascade on delete restrict;
