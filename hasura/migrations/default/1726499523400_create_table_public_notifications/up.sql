CREATE TABLE IF NOT EXISTS"public"."notifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "title" text NOT NULL, "message" text NOT NULL, "steam_id" bigint, "role" text NOT NULL, "type" text NOT NULL, "entity_id" text NOT NULL, "is_read" boolean NOT NULL DEFAULT false, "deleted_at" timestamptz, PRIMARY KEY ("id") );

CREATE TABLE IF NOT EXISTS public.e_notification_types (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);



DO $$
BEGIN
   IF NOT EXISTS (
       SELECT 1
       FROM information_schema.table_constraints
       WHERE constraint_name = 'notifications_steam_id_fkey'
         AND table_name = 'notifications'
   ) THEN
       ALTER TABLE "public"."notifications"
       ADD CONSTRAINT "notifications_steam_id_fkey"
       FOREIGN KEY ("steam_id")
       REFERENCES "public"."players" ("steam_id")
       ON UPDATE CASCADE
       ON DELETE CASCADE;
   END IF;
    
   IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'notifications_type_fkey'
          AND table_name = 'notifications'
    ) THEN
        ALTER TABLE "public"."notifications"
        ADD CONSTRAINT "notifications_type_fkey"
        FOREIGN KEY ("type")
        REFERENCES "public"."e_notification_types" ("value")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'notifications_role_fkey'
          AND table_name = 'notifications'
    ) THEN
        ALTER TABLE "public"."notifications"
        ADD CONSTRAINT "notifications_role_fkey"
        FOREIGN KEY ("role")
        REFERENCES "public"."e_player_roles" ("value")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;
END $$;
