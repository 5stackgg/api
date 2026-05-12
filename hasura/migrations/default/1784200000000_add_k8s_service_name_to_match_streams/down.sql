alter table "public"."match_streams"
  drop column if exists "k8s_service_name";
