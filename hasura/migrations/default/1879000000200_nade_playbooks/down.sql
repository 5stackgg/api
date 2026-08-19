ALTER TABLE IF EXISTS "public"."nade_practice_sessions"
    DROP COLUMN IF EXISTS "playbook_id";

DROP TABLE IF EXISTS "public"."nade_playbook_steps";
DROP TABLE IF EXISTS "public"."nade_playbooks";
