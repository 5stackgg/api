alter table "public"."match_type_cfgs" drop constraint "match_type_cfgs_type_fkey";

drop table "public"."e_game_cfg_types";

alter table "public"."match_type_cfgs"
  add constraint "match_type_cfgs_type_fkey"
  foreign key ("type")
  references "public"."e_match_types"
  ("value") on update cascade on delete restrict;
