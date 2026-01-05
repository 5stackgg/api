truncate table player_elo;

alter table "public"."player_elo" add column if not exists "type" text
 not null;

alter table "public"."player_elo"
  add constraint "player_elo_type_fkey"
  foreign key ("type")
  references "public"."e_match_types"
  ("value") on update cascade on delete restrict;

ALTER TABLE "public"."player_elo" DROP CONSTRAINT "player_elo_pkey";

ALTER TABLE "public"."player_elo"
    ADD CONSTRAINT "player_elo_pkey" PRIMARY KEY ("steam_id", "match_id", "type");
