alter table "public"."servers" drop constraint "servers_reserved_by_match_id_fkey",
  add constraint "servers_reserved_by_match_id_fkey"
  foreign key ("reserved_by_match_id")
  references "public"."matches"
  ("id") on update cascade on delete set null;
