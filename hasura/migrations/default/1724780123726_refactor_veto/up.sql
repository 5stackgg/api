alter table "public"."matches" add column "region" text
 null;

alter table "public"."matches"
  add constraint "matches_region_fkey"
  foreign key ("region")
  references "public"."server_regions"
  ("value") on update cascade on delete restrict;

CREATE TABLE "public"."match_region_veto_picks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "match_id" uuid NOT NULL, "type" text NOT NULL, "match_lineup_id" uuid NOT NULL, "region" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("id") , FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade, FOREIGN KEY ("type") REFERENCES "public"."e_veto_pick_types"("value") ON UPDATE cascade ON DELETE restrict, FOREIGN KEY ("region") REFERENCES "public"."server_regions"("value") ON UPDATE cascade ON DELETE restrict);

alter table "public"."match_region_veto_picks"
  add constraint "match_region_veto_picks_match_lineup_id_fkey"
  foreign key ("match_lineup_id")
  references "public"."match_lineups"
  ("id") on update cascade on delete restrict;

alter table "public"."match_options" add column "region_veto" boolean
 not null default 'true';