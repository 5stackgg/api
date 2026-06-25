CREATE TABLE "public"."e_system_alert_types" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value"), UNIQUE ("value"));

INSERT INTO "public"."e_system_alert_types" ("value", "description") VALUES
  ('info', 'Informational'),
  ('warning', 'Warning'),
  ('critical', 'Critical')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE "public"."system_alerts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "type" text NOT NULL DEFAULT 'info',
  "title" text,
  "message" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "dismissible" boolean NOT NULL DEFAULT true,
  "expires_at" timestamptz,
  "created_by" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "system_alerts_type_fkey"
    FOREIGN KEY ("type") REFERENCES "public"."e_system_alert_types" ("value")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "system_alerts_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "public"."players" ("steam_id")
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "system_alerts_is_active_idx" ON "public"."system_alerts" ("is_active");
