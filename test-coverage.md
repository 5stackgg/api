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

#### `src/cache/CacheTag.spec.ts` — Cache Tag Constants (13 tests)
Tests cache tag string generation for various entity types.
- Generates correct tags for match entities
- Generates correct tags for player entities
- Generates correct tags for tournament entities
- Handles parameterized tags with IDs
- Returns consistent tag format
- Validates tag uniqueness across entity types

#### `src/matchmaking/matchmake.service.spec.ts` — Matchmaking Engine (23 tests)
Tests the core matchmaking algorithm with Elo-based team balancing.
- **Queue management:** adds/removes players from queue
- **Elo balancing:** creates balanced teams within Elo threshold
- **Party support:** keeps party members on same team
- **Region matching:** matches players in same region
- **Map preferences:** considers map pool overlap
- **Edge cases:** handles odd player counts, insufficient players, empty queues
- **Cooldowns:** respects matchmaking cooldown timers

#### `src/matchmaking/matchmaking-lobby.service.spec.ts` — Lobby Management (21 tests)
Tests pre-match lobby lifecycle from creation to launch.
- **Lobby creation:** creates lobby with correct parameters
- **Player ready-up:** tracks ready status per player
- **Timeout handling:** cancels lobby if not all players ready
- **Map voting:** tallies votes, resolves ties
- **Server assignment:** requests game server allocation
- **Lobby dissolution:** cleans up on cancel or timeout
- **Notifications:** sends correct events to lobby members

#### `src/matches/match-assistant/match-assistant.service.spec.ts` — Match Assistant (14 tests)
Tests match lifecycle management (scheduling, canceling, server assignment).
- **Match creation:** validates required fields
- **Server assignment:** assigns available game servers
- **Match cancellation:** handles graceful cancel flow
- **Status transitions:** enforces valid state machine transitions
- **Lineup management:** adds/removes players from match lineups
- **Match data retrieval:** returns correct match details

#### `src/notifications/notifications.service.spec.ts` — Push Notifications (14 tests)
Tests the notification dispatch system across channels.
- **Delivery:** sends to correct recipients
- **Channel routing:** routes to Discord, in-app, or both
- **Templates:** renders notification templates correctly
- **Batching:** groups notifications for efficiency
- **Preferences:** respects user notification preferences
- **Error handling:** handles delivery failures gracefully

#### `src/encryption/encryption.service.spec.ts` — Encryption Service (3 tests)
Tests the encryption service decrypt functionality.
- Strips hex string prefix from Hasura format
- Passes correct openpgp parameters
- Logs error on decryption failure

#### `src/rcon/rcon.service.spec.ts` — RCON Service (12 tests)
Tests RCON service parsing and locking.
- **Cvar parsing:** handles various output formats (headers, empty lines, noisy status)
- **Disconnect:** cleans up connections
- **Lock methods:** Redis-based lock acquisition/release for cvars and prefixes

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

#### `src/matches/matches.controller.spec.ts` — Match REST Endpoints (12 tests)
Tests HTTP request handling for match operations.
- **Authentication:** rejects unauthenticated requests
- **Authorization:** enforces role-based access
- **Validation:** rejects invalid request bodies
- **CRUD operations:** handles match creation, retrieval, update, cancel
- **Error responses:** returns correct HTTP status codes
- **Server lookup:** handles server assignment endpoints

#### `src/tournaments/tournaments.controller.spec.ts` — Tournament Controller (9 tests)
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

#### `src/system/system.controller.spec.ts` — System Controller (11 tests)
Tests system controller endpoints and event handlers.
- **updateServices:** delegates service updates
- **restartService:** delegates service restarts
- **registerName:** handles player name registration
- **approveNameChange:** approves player name changes
- **requestNameChange:** validates name change requests
- **settings event:** handles demo network limiters and chat TTL

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

#### `src/matches/events/MatchMapStatusEvent.spec.ts` — Match Map Status Event (7 tests)
- Returns early when match has no current_match_map_id
- Updates match map status
- Includes/excludes winning_lineup_id based on presence
- Sends pause notification when status is Paused
- Calls sendServerMatchId when map finished but more maps remain
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

#### `src/matches/events/MatchMapResetRoundEvent.spec.ts` — Match Map Reset Round Event (5 tests)
- Clears deleted_at on stats tables for rounds > target
- Sets deleted_at on stats tables for rounds > target
- Clears/sets deleted_at on match_map_rounds
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
