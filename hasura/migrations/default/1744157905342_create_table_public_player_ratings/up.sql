CREATE TABLE "public"."player_elo" ("steam_id" bigint NOT NULL, "match_id" uuid NOT NULL, "current" numeric NOT NULL, "change" numeric NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("steam_id","match_id") , FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade, FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade);


CREATE INDEX idx_player_elo_steam_id ON public.player_elo(steam_id);
CREATE INDEX idx_player_elo_match_id ON public.player_elo(match_id);
CREATE INDEX idx_player_elo_created_at ON public.player_elo(created_at);