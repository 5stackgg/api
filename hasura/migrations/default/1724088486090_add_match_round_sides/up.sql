
alter table "public"."match_map_rounds" add column "lineup_1_side" text
 not null;

alter table "public"."match_map_rounds"
  add constraint "match_map_rounds_lineup_1_side_fkey"
  foreign key ("lineup_1_side")
  references "public"."e_sides"
  ("value") on update cascade on delete restrict;

alter table "public"."match_map_rounds" add column "lineup_2_side" text
 not null;

alter table "public"."match_map_rounds"
  add constraint "match_map_rounds_lineup_2_side_fkey"
  foreign key ("lineup_2_side")
  references "public"."e_sides"
  ("value") on update cascade on delete restrict;
