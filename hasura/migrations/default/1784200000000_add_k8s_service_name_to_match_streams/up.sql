alter table "public"."match_streams"
  add column if not exists "k8s_service_name" text;
