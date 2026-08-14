-- notifications had no index beyond its primary key. Three separate features
-- now dedupe by (type, entity_id) via NOT EXISTS -- LeagueWeekReminders,
-- TournamentReminders, and the ChatMessage bell collapse -- and the bell reads
-- unread rows per player on every page load.
CREATE INDEX IF NOT EXISTS "notifications_type_entity_id_idx"
    ON "public"."notifications" ("type", "entity_id");

CREATE INDEX IF NOT EXISTS "notifications_unread_steam_id_idx"
    ON "public"."notifications" ("steam_id")
    WHERE "is_read" = false AND "deleted_at" IS NULL;
