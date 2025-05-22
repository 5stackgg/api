CREATE TABLE "public"."e_game_cfg_types" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

insert into e_game_cfg_types ("value", "description") values
    ('Base', 'Base game configuration'),
    ('Lan', 'Lan game configuration'),
    ('Live', 'Live game configuration'),
    ('Competitive', 'Competitive game configuration'),
    ('Wingman', 'Wingman game configuration'),
    ('Duel', 'Duel game configuration')
on conflict(value) do update set "description" = EXCLUDED."description";

alter table "public"."match_type_cfgs" drop constraint "match_type_cfgs_type_fkey";

alter table "public"."match_type_cfgs"
  add constraint "match_type_cfgs_type_fkey"
  foreign key ("type")
  references "public"."e_game_cfg_types"
  ("value") on update cascade on delete restrict;