-- The practice bar in the top nav already says a server is booting and when it
-- is up, on every page, for as long as the session lasts. A bell row saying the
-- same thing arrived a moment later, said less, and outlived the server it was
-- about -- the reaper stops an empty session, so a row sitting unread in the
-- bell points at nothing.
--
-- notifications.type is FK'd to this table ON DELETE CASCADE, so removing the
-- enum value takes every row of it with it. Existing installs seeded the value
-- from hasura/enums/notification-types.sql, which no longer lists it; a fresh
-- install never had it, and this is a no-op there.
DELETE FROM public.e_notification_types WHERE "value" = 'UtilityPracticeReady';

-- notification_preferences.key is plain text with no foreign key, so the
-- per-player in-app toggle for the type would otherwise sit in the table
-- forever, unreachable and unreadable.
DELETE FROM public.notification_preferences WHERE "key" = 'UtilityPracticeReady';
