-- Who is still owed a "your server is up".
--
-- The practice bar in the top nav says it already, on every page, for as long
-- as the session lasts -- so for somebody who pressed Start and stayed there,
-- a bell row says the same thing a moment later and says it worse. The
-- exception is a player who was turned away for want of a server: they queued,
-- and the whole point of a queue is that you stop watching it. Only their
-- session carries this.
ALTER TABLE "public"."utility_practice_sessions"
    ADD COLUMN IF NOT EXISTS "notify_when_ready" boolean NOT NULL DEFAULT false;
