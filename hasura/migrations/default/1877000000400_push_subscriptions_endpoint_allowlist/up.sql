-- Endpoints were stored unvalidated before src/notifications/push/push-endpoint.ts
-- existed, so anything already in the table bypassed the subscribe-time check.
-- Sweep them: a row that does not point at a real push service is either junk
-- or an attempt to aim the API at something it should not reach.
--
-- Deleting rather than flagging is safe -- a legitimate browser simply
-- re-subscribes on its next visit.
DELETE FROM "public"."push_subscriptions"
 WHERE "endpoint" !~* '^https://([a-z0-9-]+\.)*(push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)(/|$)'
   AND "endpoint" !~* '^https://(fcm|android)\.googleapis\.com(/|$)';

-- Keeps the invariant true for anything inserted outside the application, and
-- makes the intent visible in the schema rather than only in TypeScript.
ALTER TABLE "public"."push_subscriptions"
  DROP CONSTRAINT IF EXISTS "push_subscriptions_endpoint_is_push_service";

ALTER TABLE "public"."push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_endpoint_is_push_service" CHECK (
    "endpoint" ~* '^https://([a-z0-9-]+\.)*(push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)(/|$)'
    OR "endpoint" ~* '^https://(fcm|android)\.googleapis\.com(/|$)'
  );
