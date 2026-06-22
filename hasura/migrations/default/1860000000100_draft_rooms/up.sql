CREATE TABLE "public"."e_draft_game_status" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value"), UNIQUE ("value"));

INSERT INTO "public"."e_draft_game_status" ("value", "description") VALUES
  ('Open', 'Accepting Players'),
  ('Filled', 'Lobby Full'),
  ('SelectingCaptains', 'Selecting Captains'),
  ('Drafting', 'Drafting Players'),
  ('CreatingMatch', 'Creating Match'),
  ('Completed', 'Completed'),
  ('Canceled', 'Canceled')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE "public"."e_draft_game_captain_selection" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value"), UNIQUE ("value"));

INSERT INTO "public"."e_draft_game_captain_selection" ("value", "description") VALUES
  ('TopEloTwo', 'Top 2 by Rank'),
  ('HostAndNext', 'Host and Next Highest'),
  ('RandomTwo', 'Random Two')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE "public"."e_draft_game_draft_order" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value"), UNIQUE ("value"));

INSERT INTO "public"."e_draft_game_draft_order" ("value", "description") VALUES
  ('Snake', 'Snake (1-2-2-2-1)'),
  ('Alternating', 'Alternating')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE "public"."e_draft_game_mode" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value"), UNIQUE ("value"));

INSERT INTO "public"."e_draft_game_mode" ("value", "description") VALUES
  ('Captains', 'Two Captains Draft'),
  ('Host', 'Host Assigns Teams'),
  ('Pug', 'Auto-Split Teams'),
  ('Teams', 'Pre-Made Teams')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE "public"."e_draft_game_player_status" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value"), UNIQUE ("value"));

INSERT INTO "public"."e_draft_game_player_status" ("value", "description") VALUES
  ('Accepted', 'Player Accepted Into Game'),
  ('Requested', 'Player Requested To Join'),
  ('Waitlist', 'Player On Waitlist')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE "public"."draft_games" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "host_steam_id" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'Open',
  "type" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'Captains',
  "access" text NOT NULL DEFAULT 'Open',
  "invite_code" uuid NOT NULL DEFAULT gen_random_uuid(),
  "regions" text[] NOT NULL DEFAULT '{}',
  "map_pool_id" uuid,
  "match_options_id" uuid,
  "captain_selection" text NOT NULL DEFAULT 'TopEloTwo',
  "draft_order" text NOT NULL DEFAULT 'Snake',
  "min_elo" integer,
  "max_elo" integer,
  "capacity" integer NOT NULL,
  "require_approval" boolean NOT NULL DEFAULT false,
  "match_id" uuid,
  "team_1_id" uuid,
  "team_2_id" uuid,
  "inner_squad" boolean NOT NULL DEFAULT false,
  "current_pick_lineup" integer,
  "pick_deadline" timestamptz,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

alter table "public"."draft_games"
  add constraint "draft_games_host_steam_id_fkey"
  foreign key ("host_steam_id")
  references "public"."players" ("steam_id") on update cascade on delete cascade;

alter table "public"."draft_games"
  add constraint "draft_games_status_fkey"
  foreign key ("status")
  references "public"."e_draft_game_status" ("value") on update cascade on delete restrict;

alter table "public"."draft_games"
  add constraint "draft_games_type_fkey"
  foreign key ("type")
  references "public"."e_match_types" ("value") on update cascade on delete restrict;

alter table "public"."draft_games"
  add constraint "draft_games_mode_fkey"
  foreign key ("mode")
  references "public"."e_draft_game_mode" ("value") on update cascade on delete restrict;

alter table "public"."draft_games"
  add constraint "draft_games_access_fkey"
  foreign key ("access")
  references "public"."e_lobby_access" ("value") on update cascade on delete restrict;

alter table "public"."draft_games"
  add constraint "draft_games_captain_selection_fkey"
  foreign key ("captain_selection")
  references "public"."e_draft_game_captain_selection" ("value") on update cascade on delete restrict;

alter table "public"."draft_games"
  add constraint "draft_games_draft_order_fkey"
  foreign key ("draft_order")
  references "public"."e_draft_game_draft_order" ("value") on update cascade on delete restrict;

alter table "public"."draft_games"
  add constraint "draft_games_map_pool_id_fkey"
  foreign key ("map_pool_id")
  references "public"."map_pools" ("id") on update cascade on delete set null;

alter table "public"."draft_games"
  add constraint "draft_games_match_options_id_fkey"
  foreign key ("match_options_id")
  references "public"."match_options" ("id") on update cascade on delete set null;

alter table "public"."draft_games"
  add constraint "draft_games_match_id_fkey"
  foreign key ("match_id")
  references "public"."matches" ("id") on update cascade on delete set null;

alter table "public"."draft_games"
  add constraint "draft_games_team_1_id_fkey"
  foreign key ("team_1_id")
  references "public"."teams" ("id") on update cascade on delete set null;

alter table "public"."draft_games"
  add constraint "draft_games_team_2_id_fkey"
  foreign key ("team_2_id")
  references "public"."teams" ("id") on update cascade on delete set null;

CREATE INDEX "draft_games_status_idx" ON "public"."draft_games" ("status");
CREATE INDEX "draft_games_host_steam_id_idx" ON "public"."draft_games" ("host_steam_id");
CREATE INDEX "draft_games_map_pool_id_idx" ON "public"."draft_games" ("map_pool_id");
CREATE INDEX "draft_games_match_options_id_idx" ON "public"."draft_games" ("match_options_id");
CREATE INDEX "draft_games_match_id_idx" ON "public"."draft_games" ("match_id");
CREATE INDEX "draft_games_team_1_id_idx" ON "public"."draft_games" ("team_1_id");
CREATE INDEX "draft_games_team_2_id_idx" ON "public"."draft_games" ("team_2_id");
CREATE UNIQUE INDEX "draft_games_invite_code_key" ON "public"."draft_games" ("invite_code");

CREATE TABLE "public"."draft_game_players" (
  "draft_game_id" uuid NOT NULL,
  "steam_id" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'Accepted',
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "elo_snapshot" integer,
  "is_captain" boolean NOT NULL DEFAULT false,
  "lineup" integer,
  "pick_order" integer,
  PRIMARY KEY ("draft_game_id", "steam_id"),
  FOREIGN KEY ("draft_game_id") REFERENCES "public"."draft_games" ("id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("steam_id") REFERENCES "public"."players" ("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("status") REFERENCES "public"."e_draft_game_player_status" ("value") ON UPDATE cascade ON DELETE restrict
);

CREATE INDEX "draft_game_players_steam_id_idx" ON "public"."draft_game_players" ("steam_id");
CREATE UNIQUE INDEX "draft_game_players_captain_lineup_key" ON "public"."draft_game_players" ("draft_game_id", "lineup") WHERE "is_captain";

CREATE TABLE "public"."draft_game_picks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "draft_game_id" uuid NOT NULL,
  "captain_steam_id" bigint NOT NULL,
  "picked_steam_id" bigint NOT NULL,
  "lineup" integer NOT NULL,
  "auto_picked" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("draft_game_id") REFERENCES "public"."draft_games" ("id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("captain_steam_id") REFERENCES "public"."players" ("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("picked_steam_id") REFERENCES "public"."players" ("steam_id") ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX "draft_game_picks_draft_game_id_idx" ON "public"."draft_game_picks" ("draft_game_id");
CREATE INDEX "draft_game_picks_captain_steam_id_idx" ON "public"."draft_game_picks" ("captain_steam_id");
CREATE INDEX "draft_game_picks_picked_steam_id_idx" ON "public"."draft_game_picks" ("picked_steam_id");
