# Test Coverage — API

## Overview

- **Framework:** Jest + ts-jest
- **Coverage threshold:** 40% global minimum (branches, functions, lines, statements)
- **Test command:** `npx jest --no-cache --coverage`
- **E2E command:** `npx jest --config test/jest-e2e.json --no-cache`

---

## Unit Tests

### Utility Functions

#### `src/utilities/isRoleAbove.spec.ts` — Role Hierarchy (4 tests)
Tests the `isRoleAbove` utility that compares user role precedence.
- Correctly identifies when a role is above another
- Correctly identifies when a role is not above another
- Handles equal roles
- Handles edge cases with undefined roles

#### `src/utilities/isJsonEqual.spec.ts` — JSON Deep Equality (16 tests)
Tests deep equality comparison of JSON objects.
- Primitive comparisons (strings, numbers, booleans, null)
- Nested object equality and inequality
- Array ordering and content comparison
- Mixed types and edge cases (empty objects, empty arrays)
- Handles undefined values and missing keys

#### `src/utilities/safeJsonStringify.spec.ts` — Safe JSON Serialization (6 tests)
Tests a `JSON.stringify` wrapper that handles circular references and errors.
- Stringifies simple objects
- Handles circular references gracefully
- Handles null, undefined, and primitive inputs
- Returns fallback string on error
- Handles deeply nested objects

#### `src/utilities/veto-pattern.spec.ts` — Map Veto Patterns (8 tests)
Tests the generation of map veto sequences for BO1, BO3, and BO5 formats.
- Generates correct ban/pick pattern for BO1
- Generates correct ban/pick pattern for BO3
- Generates correct ban/pick pattern for BO5
- Validates pattern length matches expected steps
- Alternates between teams correctly
- Assigns correct action types (ban/pick/decider)

#### `src/utilities/getCookieOptions.spec.ts` — Cookie Configuration (8 tests)
Tests cookie option generation for different environments.
- Sets secure flag in production
- Sets correct domain in production
- Omits secure flag in development
- Uses correct sameSite policy
- Sets httpOnly flag
- Handles custom maxAge values
- Returns correct path
- Handles missing environment variables

#### `src/matchmaking/utilities/cacheKeys.spec.ts` — Matchmaking Cache Keys (7 tests)
Tests cache key generation functions for matchmaking queues, lobby details, confirmations, and ranks.
- Validates correct formatting with regions/types
- Ensures different inputs produce different keys
- Verifies queue/rank keys differ for same input

#### `src/discord-bot/utilities/getDiscordDisplayName.spec.ts` — Discord Display Name (2 tests)
Tests display name resolution for Discord users.
- Prefers globalName when available
- Falls back to username when globalName is empty

#### `src/notifications/utilities/constants.spec.ts` — Notification Constants (8 tests)
Tests notification constant definitions.
- STATUS_LABELS have human-readable labels
- STATUS_COLORS map to valid Discord hex colors
- DISCORD_COLORS define specific green/red/gray values
- NOTIFIABLE_STATUSES includes/excludes correct match statuses

---

### Services

#### `src/cache/cache.service.spec.ts` — Redis Cache Service (19 tests)
Tests the Redis-backed caching layer with TTL and invalidation.
- **Basic operations:** get, set, delete
- **TTL handling:** sets expiry, returns null for expired keys
- **Cache tags:** associates keys with tags, invalidates by tag
- **Serialization:** stores/retrieves objects, arrays, nested structures
- **Error handling:** handles Redis connection errors gracefully
- **Batch operations:** multi-key get and delete

#### `src/cache/CacheTag.spec.ts` — Cache Tag Class (14 tests)
Tests the CacheTag class for key-value caching with tag-based grouping.
- **Constructor:** joins tags with colon separator
- **put:** stores value under tag key, merges with existing values, sets forgetTag TTL when seconds provided, returns false on error
- **get:** returns all values when no key specified, returns specific key value, returns undefined for missing key, returns undefined when tag not in cache
- **has:** returns true when key exists, returns false when key missing
- **forget:** removes specific key from tag values, forgets entire tag when no key specified
- **waitForLock:** delegates to cacheStore.lock with 60s expiry

#### `src/matchmaking/matchmake.service.spec.ts` — Matchmaking Engine (15 tests)
Tests the core matchmaking algorithm with Elo-based team balancing and multi-region lobby claiming.
- **createMatches:** creates 1 match from 15 players, rejects insufficient players, handles exactly 10 players, creates 2 matches for distinct ELO groups, balances teams with variable lobby sizes
- **claimLobby:** returns false when already claimed by another region, passes all regional queue/rank keys to Lua script, returns false when lobby details not found
- **Multi-region lobbies:** skips lobbies that fail to claim (already claimed by another region)
- **Region lock:** returns early when lock cannot be acquired, releases lock and returns when queue is empty
- **getNumberOfPlayersInQueue:** returns zcard count for the queue key
- **addLobbyToQueue:** adds lobby to rank and queue sorted sets for each region, does not add when lobby details not found
- **releaseLobbyAndRequeue:** releases lock and re-adds lobby to all regional queues

#### `src/matchmaking/matchmaking-lobby.service.spec.ts` — Lobby Verification (15 tests)
Tests lobby verification logic including captain checks, team size validation, and player eligibility.
- **Captain check:** throws when user is not the captain, accepts when user is the captain
- **Competitive team sizes:** accepts 1-5 players, accepts exactly 10 players, rejects 6-9 players
- **Wingman team sizes:** accepts 1-2 players, accepts exactly 4 players, rejects 3 players
- **Duel team sizes:** accepts 1 player, accepts exactly 2 players
- **Player verification:** rejects banned player, rejects player with matchmaking cooldown, rejects player already in another match, rejects player already in a different queue, accepts player in same lobby

#### `src/matches/match-assistant/match-assistant.service.spec.ts` — Match Assistant (16 tests)
Tests match lifecycle management (scheduling, canceling, server assignment, maps).
- **GetMatchServerJobId:** returns job name prefixed with m-
- **canSchedule:** returns true/false based on Hasura response, passes user steam_id
- **canCancel:** returns true/false based on match can_cancel field
- **canStart:** returns true/false based on match can_start field
- **isOrganizer:** returns true/false for organizer check, passes user steam_id to Hasura query
- **updateMatchStatus:** sends mutation with correct status
- **assignServer:** assigns dedicated server when preferred and available, sets WaitingForServer when none available and on-demand fails
- **isDedicatedServerAvailable:** throws when match has no server
- **getAvailableMaps:** filters out banned and picked maps, throws when map pool not found

#### `src/notifications/notifications.service.spec.ts` — Match Status Notifications (8 tests)
Tests match status notification dispatch with Discord webhook support.
- **Non-notifiable status:** skips statuses not in NOTIFIABLE_STATUSES
- **Standalone match:** notifies organizer and players, returns early if match not found
- **Tournament match:** notifies tournament organizers
- **Discord webhook cascade:** uses tournament webhook when available, falls back to match webhook, skips invalid webhook URL
- **Error handling:** logs error and does not throw

#### `src/encryption/encryption.service.spec.ts` — Encryption Service (3 tests)
Tests the encryption service decrypt functionality.
- Strips hex string prefix from Hasura format
- Passes correct openpgp parameters
- Logs error on decryption failure

#### `src/rcon/rcon.service.spec.ts` — RCON Service (13 tests)
Tests RCON service cvar parsing, connection management, and Redis-based locking.
- **parseCvarList:** parses standard 4-column output, skips empty/header/footer lines, skips noisy status lines, handles empty description, logs warning for unparseable lines, returns empty array for empty input
- **Disconnect:** ends connection and cleans up when exists, does nothing when no connection exists
- **Lock methods:** acquireCvarsLock returns true/false, releaseCvarsLock deletes key, acquirePrefixLock returns true, releasePrefixLock deletes key

#### `src/system/system.service.spec.ts` — System Settings Service (10 tests)
Tests system settings retrieval and updates.
- **getSetting:** returns database values with type conversion (string/boolean/number)
- **Defaults:** applies default values when missing/null
- **updateDefaultOptions:** handles default_models setting changes

#### `src/matches/match-relay/match-relay.service.spec.ts` — Match Relay Service (8 tests)
Tests match relay/broadcast service.
- **removeBroadcast:** removes broadcast data
- **getStart:** serves start fragment with 404 handling
- **getFragment:** retrieves broadcast fragments
- **isSyncReady:** validates sync readiness (requires full/delta data with ticks/timestamps)
- **cleanupOldFragments:** cleans old fragments while preserving index 0

---

### Controllers

#### `src/matches/matches.controller.spec.ts` — Match Controller (62 tests)
Tests match event handling, scheduling, starting, canceling, forfeiting, lineup management, and server availability.
- **match_events — status notification (2):** sends notification when status changes, does not notify when unchanged
- **match_events — terminal status (8):** queues ELO calculation on Finished/Canceled/Forfeit/Tie/Surrendered, cancels matchmaking, schedules on-demand server stop for non-dedicated, does not schedule for dedicated, uses 0 delay for Canceled
- **match_events — DELETE (1):** removes chat lobby on DELETE
- **match_events — server changes (2):** stops on-demand server when server_id changes, assigns server when transitioning to Live without server
- **scheduleMatch (5):** throws when cannot schedule, throws when time in past, sets Scheduled with time, sets WaitingForCheckIn without time, throws on wrong status
- **startMatch (5):** throws when cannot start, sets Live with server_id, returns success on Veto, throws when not Live/Veto, throws when update returns null
- **cancelMatch (2):** throws when cannot cancel, calls updateMatchStatus with Canceled
- **forfeitMatch (5):** throws when not organizer, throws when not found, throws when already terminal, sets Forfeit with winning_lineup_id, throws on wrong result
- **setMatchWinner (2):** throws when not organizer, sets winning_lineup_id via mutation
- **joinLineup (4):** throws for Private, throws for Invite with wrong code, allows with correct code, allows Open
- **leaveLineup (2):** returns success, returns false when no player found
- **switchLineup (4):** throws for Private, throws when not on lineup, throws when target full, switches successfully
- **deleteMatch (3):** throws when Live, removes demos from S3 and deletes match, handles match_options deletion error gracefully
- **checkIntoMatch (3):** throws when not WaitingForCheckIn, marks player as checked_in, transitions to Live when both lineups ready
- **server_availability (5):** returns early when disabled/disconnected/reserved, assigns server to oldest waiting match, does nothing when none waiting
- **node_server_availability (4):** returns early when disabled/not Online, assigns servers to multiple waiting matches, handles no waiting matches
- **match_veto_pick (1):** calls updateMatchOverview with matchId
- **match_lineup_players (3):** sends server match id when Live, does nothing when not Live, does nothing when not found

#### `src/tournaments/tournaments.controller.spec.ts` — Tournament Controller (7 tests)
Tests tournament deletion and cleanup operations.
- Throws when tournament not found
- Throws when not the organizer
- Throws when tournament is Live
- Cleans up demo files from S3 and deletes matches
- Handles individual demo cleanup failures gracefully
- Handles empty tournament with no stages
- Handles bracket with no match

#### `src/auth/auth.controller.spec.ts` — Auth Controller (7 tests)
Tests authentication endpoints and session management.
- **me:** returns user with cached name and role
- **unlinkDiscord:** removes discord_id via Hasura mutation, clears from session
- **logout:** destroys session and deletes Redis latency key, handles missing session
- **createApiKey:** throws BadRequestException when label is empty, returns key

#### `src/system/system.controller.spec.ts` — System Controller (13 tests)
Tests system controller endpoints and event handlers.
- **updateServices:** delegates to system.updateServices
- **restartService:** delegates to system.restartService
- **registerName:** updates player name and sets name_registered
- **approveNameChange:** updates player name by steam_id
- **requestNameChange:** throws when pending request exists, throws when player not found, sends notification with approve action
- **settings event:** updates demo network limiters on change, does not update when unchanged, updates on INSERT, updates chat TTL, defaults chat TTL to 3600 when NaN, always calls updateDefaultOptions

---

### Gateways

#### `src/rcon/rcon.gateway.spec.ts` — RCON Gateway (9 tests)
Tests gateway authorization and RCON event handling.
- **Role-based access:** denies user/verified_user/streamer, allows administrator
- **Organizer access:** checks for active matches
- **No active match:** handles access when no match is active
- **Connection failure:** handles RCON connection failures

#### `src/matches/match-events.gateway.spec.ts` — Match Events Gateway (5 tests)
Tests match events gateway authentication and event processing.
- **handleConnection:** validates Basic auth credentials against database
- **handleMatchEvent:** detects duplicate events via cache, resolves and invokes event processors

---

### Match Event Processors

#### `src/matches/events/AssistEvent.spec.ts` — Assist Event (1 test)
- Inserts assist with correct fields

#### `src/matches/events/FlashEvent.spec.ts` — Flash Event (1 test)
- Inserts flash with duration and team_flash flag

#### `src/matches/events/ObjectiveEvent.spec.ts` — Objective Event (1 test)
- Inserts objective with player_steam_id, type, and round

#### `src/matches/events/UtilityEvent.spec.ts` — Utility Event (1 test)
- Inserts utility with type and attacker coordinates

#### `src/matches/events/KillEvent.spec.ts` — Kill Event (2 tests)
- Inserts kill with full attacker data when attacker_steam_id is present
- Falls back to attacked_steam_id as attacker for self-damage

#### `src/matches/events/DamageEvent.spec.ts` — Damage Event (2 tests)
- Inserts damage with attacker data when attacker_steam_id is present
- Omits attacker fields when attacker_steam_id is falsy

#### `src/matches/events/ScoreEvent.spec.ts` — Score/Round Event (3 tests)
- Calls cleanupData before inserting round
- Inserts round with upsert on_conflict
- Cleanup deletes soft-deleted records filtering by match_map_id

#### `src/matches/events/MatchMapStatusEvent.spec.ts` — Match Map Status Event (8 tests)
- Returns early when match has no current_match_map_id
- Updates match map status
- Includes winning_lineup_id when provided
- Does not include winning_lineup_id when not provided
- Sends pause notification when status is Paused
- Calls sendServerMatchId when map finished but more maps remain
- Does not call sendServerMatchId when no more maps remain
- Does not send pause notification for non-Paused status

#### `src/matches/events/MatchForfeited.spec.ts` — Match Forfeited Event (1 test)
- Sets match status to Forfeit with winning_lineup_id

#### `src/matches/events/MatchSurrendered.spec.ts` — Match Surrendered Event (2 tests)
- Sets match status to Surrendered with winning_lineup_id
- Logs error and does not throw on mutation failure

#### `src/matches/events/MatchAbandoned.spec.ts` — Match Abandoned Event (1 test)
- Inserts abandoned_matches record with steam_id

#### `src/matches/events/PlayerConnected.spec.ts` — Player Connected Event (2 tests)
- Upserts player with on_conflict update name
- Joins chat lobby via game

#### `src/matches/events/MatchMapResetRoundEvent.spec.ts` — Match Map Reset Round Event (6 tests)
- First mutation clears deleted_at on stats tables for rounds > target
- Second mutation sets deleted_at on stats tables for rounds > target
- Clears deleted_at on match_map_rounds
- Queries rounds > target and marks them with deleted_at
- Restores timeout availability from target round
- Calls matchAssistant.restoreMatchRound

#### `src/matches/events/TechTimeout.spec.ts` — Tech Timeout Event (1 test)
- Updates match map timeout availability for both lineups

#### `src/matches/events/PlayerDisconnected.spec.ts` — Player Disconnected Event (1 test)
- Calls chat.leaveLobbyViaGame with matchId and steam_id

#### `src/matches/events/ChatMessageEvent.spec.ts` — Chat Message Event (2 tests)
- Queries player and sends chat message when player found
- Logs warning and returns early when player not found

#### `src/matches/events/CaptainEvent.spec.ts` — Captain Event (4 tests)
- Finds player by steam_id and updates captain
- Finds player by player.name prefix and updates captain via discord_id
- Finds player by placeholder_name prefix and updates captain via discord_id
- Returns early when player not found in lineups

#### `src/matches/events/KnifeSwitch.spec.ts` — Knife Switch Event (2 tests)
- Swaps lineup sides on current map
- Calls matchAssistant.knifeSwitch after mutation

#### `src/matches/events/MatchUpdatedLineupsEvent.spec.ts` — Match Updated Lineups Event (5 tests)
- Skips players with steam_id '0'
- Upserts each valid player via insert_players_one
- Returns early without lineup changes when player count < expected
- Removes non-participating players from lineups
- Inserts only new players not already on lineup

---

### Jobs (BullMQ Processors)

#### `src/matches/jobs/CancelExpiredMatches.spec.ts` — Expired Match Cleanup (5 tests)
Tests the scheduled job that cancels matches past their start window.
- Cancels matches beyond expiry threshold
- Skips matches still within grace period
- Handles matches already cancelled
- Processes multiple expired matches in batch
- Logs cancellation events

#### `src/matches/jobs/EloCalculation.spec.ts` — Elo Rating Updates (4 tests)
Tests post-match Elo calculation and persistence.
- Calculates correct Elo delta for win/loss
- Handles draws appropriately
- Applies K-factor correctly
- Updates both teams' ratings

#### `src/matches/jobs/CheckForTournamentStart.spec.ts` — Tournament Auto-Start (6 tests)
Tests the job that transitions tournaments to Live status.
- Transitions tournament to Live when start time reached
- Skips tournaments not yet at start time
- Handles already-live tournaments
- Processes multiple tournaments in single run
- Validates tournament has required minimum teams
- Sends notification on tournament start

#### `src/matches/jobs/CleanAbandonedMatches.spec.ts` — Abandoned Match Cleanup (3 tests)
Tests the scheduled job that cleans up abandoned matches.
- Deletes abandoned matches older than 1 week
- Logs when rows are affected
- Returns 0 and does not log when nothing to clean

#### `src/matches/jobs/CancelInvalidTournaments.spec.ts` — Invalid Tournament Cancellation (3 tests)
Tests the job that cancels tournaments without minimum teams.
- Cancels tournaments without min teams past start date
- Logs count when tournaments are cancelled
- Returns 0 and does not log when none found

#### `src/matches/jobs/CheckForScheduledMatches.spec.ts` — Scheduled Match Check-In (3 tests)
Tests the job that transitions scheduled matches to check-in.
- Transitions Scheduled matches to WaitingForCheckIn within 15 min window
- Logs count when matches are transitioned
- Returns 0 and does not log when none found

#### `src/matches/jobs/RemoveCancelledMatches.spec.ts` — Cancelled Match Removal (5 tests)
Tests cleanup of cancelled non-tournament matches.
- Queries cancelled non-tournament matches
- Deletes S3 demo files and demo records for each match map
- Deletes match records after demo cleanup
- Logs count when matches removed
- Returns 0 when no cancelled matches found

#### `src/matches/jobs/StopOnDemandServer.spec.ts` — Stop On-Demand Server (1 test)
- Delegates to matchAssistant.stopOnDemandServer with matchId

#### `src/matches/jobs/CheckOnDemandServerJob.spec.ts` — Check On-Demand Server (2 tests)
- Throws when on-demand server is not running
- Updates Discord overview when server is running

#### `src/matchmaking/jobs/CancelMatchMaking.spec.ts` — Cancel Matchmaking (2 tests)
Tests matchmaking cancellation job.
- Calls cancelMatchMaking with confirmationId from job data
- Passes through different confirmationIds

#### `src/matchmaking/jobs/MarkPlayerOffline.spec.ts` — Mark Player Offline (3 tests)
Tests the job that handles player disconnection from matchmaking.
- Deletes lobby_players with Accepted status for the steamId
- Removes lobby from queue and details when player has a lobby
- Does not call removeLobbyFromQueue when player has no lobby

#### `src/system/jobs/CheckSystemUpdateJob.spec.ts` — System Update Check (1 test)
- Calls system.setVersions during execution

---

## E2E Tests

### Infrastructure

- **`test/docker-compose.test.yml`** — TimescaleDB (port 5433) and Redis (port 6380) containers
- **`test/setup.ts`** — Global setup: starts containers, waits for readiness, seeds database
- **`test/teardown.ts`** — Global teardown: stops containers with volume cleanup
- **`test/seed.ts`** — Seeds test data: players, maps, map pools via direct SQL

### Test Files

#### `test/app.e2e-spec.ts` — Application Bootstrap (4 tests)
- Application bootstraps successfully
- Root endpoint returns expected response
- Unknown routes return 404
- Steam OAuth redirect works correctly

#### `test/auth.e2e-spec.ts` — Authentication Flows (5 tests)
- Unauthenticated requests are rejected with 401
- Invalid API keys return 403
- Steam OAuth initiates correctly
- Discord OAuth initiates correctly
- Token refresh endpoint works

#### `test/matches.e2e-spec.ts` — Match Endpoints (4 tests)
- Server lookup returns 404 for unknown server
- Unauthenticated match cancel returns 401
- Unauthenticated match schedule returns 401
- Unauthenticated join lineup returns 401

---

## CI/CD

GitHub Actions workflow (`.github/workflows/test.yml`) runs on push/PR to `main` and `develop`:
1. **unit-tests** job: checkout → setup Node 20 → yarn install → jest with coverage → upload coverage artifact
2. **e2e-tests** job (depends on unit-tests): spins up TimescaleDB and Redis service containers → runs e2e tests
