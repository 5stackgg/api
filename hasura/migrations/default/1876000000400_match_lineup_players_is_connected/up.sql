-- Whether this player is in the match server right now. Only ever read as a
-- yes/no -- by the force-start check (is the lobby actually full?) and by the
-- no-show penalty on cancellation (were you here when it died?) -- so it is a
-- flag rather than a timestamp.
ALTER TABLE "public"."match_lineup_players"
  ADD COLUMN IF NOT EXISTS "is_connected" boolean NOT NULL DEFAULT false;
