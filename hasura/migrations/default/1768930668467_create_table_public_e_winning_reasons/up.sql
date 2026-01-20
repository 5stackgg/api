alter table "public"."match_map_rounds" add column if not exists "winning_reason" text
 null;

CREATE TABLE IF NOT EXISTS "public"."e_winning_reasons" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

alter table "public"."match_map_rounds"
  add constraint "match_map_rounds_winning_reason_fkey"
  foreign key ("winning_reason")
  references "public"."e_winning_reasons"
  ("value") on update cascade on delete restrict;
