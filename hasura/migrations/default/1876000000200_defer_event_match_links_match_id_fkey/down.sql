alter table "public"."event_match_links"
  alter constraint "event_match_links_match_id_fkey"
    not deferrable initially immediate;
