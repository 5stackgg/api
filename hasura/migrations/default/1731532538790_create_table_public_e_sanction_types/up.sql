CREATE TABLE IF NOT EXISTS "public"."e_sanction_types" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

alter table "public"."player_sanctions"
  add constraint "player_sanctions_type_fkey"
  foreign key ("type")
  references "public"."e_sanction_types"
  ("value") on update cascade on delete restrict;
