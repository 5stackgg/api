-- A CHECK is checked again on every update of a row, and the priority trigger
-- updates a match's other streams whenever one is removed or reordered, so a
-- link left in place that fails it would block editing every stream beside it.
-- The web no longer embeds such links, so they are removed.
DELETE FROM public.match_streams
 WHERE NOT is_game_streamer
   AND link !~* '^https?://';

ALTER TABLE public.match_streams
  ADD CONSTRAINT match_streams_link_http CHECK (link ~* '^https?://');
