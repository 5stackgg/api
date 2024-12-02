alter table "public"."notifications" add column if not exists "actions" jsonb
 null;
