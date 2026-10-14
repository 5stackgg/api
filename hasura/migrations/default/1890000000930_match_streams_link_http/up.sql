-- NOT VALID: links already stored stay as they are, every new or changed link
-- is checked.
ALTER TABLE public.match_streams
  ADD CONSTRAINT match_streams_link_http CHECK (link ~* '^https?://') NOT VALID;
