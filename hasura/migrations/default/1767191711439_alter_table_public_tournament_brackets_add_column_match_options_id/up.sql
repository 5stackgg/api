alter table "public"."tournament_brackets" add column "match_options_id" uuid
 null;

alter table "public"."tournament_brackets"
  add constraint "tournament_brackets_match_options_id_fkey"
  foreign key ("match_options_id")
  references "public"."match_options"
  ("id") on update cascade on delete restrict;

alter table "public"."tournament_stages"
  add constraint "tournament_stages_match_options_id_fkey"
  foreign key ("match_options_id")
  references "public"."match_options"
  ("id") on update cascade on delete restrict;
