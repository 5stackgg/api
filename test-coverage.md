# Test Coverage — API

## Overview

- **Framework:** Jest + ts-jest
- **Coverage threshold:** 40% global minimum (branches, functions, lines, statements)
- **Test command:** `npx jest --no-cache --coverage`
- **E2E command:** `npx jest --config test/jest-e2e.json --no-cache`

---

## Unit Tests

### Utility Functions

#### `src/utilities/is-role-above.spec.ts` — Role Hierarchy (4 tests)
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

#### `src/matches/match-assistant.service.spec.ts` — Match Assistant (14 tests)
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

#### `src/notifications/notification.constants.spec.ts` — Notification Constants (8 tests)
Tests notification type definitions and template mappings.
- All notification types have corresponding templates
- Template keys are unique
- Channel mappings are valid
- Priority levels are correctly assigned

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

---

### Stub Tests (30 files)

The following service/controller spec files contain only the default NestJS "should be defined" test. They verify that dependency injection wiring is correct but do not test business logic:

`analytics.service`, `application.service`, `commander.service`, `debug.service`, `discord.service`, `elo.service`, `encounters.service`, `game-server-node.service`, `hasura-actions.controller`, `hasura-events.controller`, `hasura-metadata.service`, `hasura.controller`, `inventory.service`, `lineup.service`, `map-bans.service`, `map-pool.service`, `match-making-global-ban.service`, `match-webhook.controller`, `match-webhook.service`, `players.service`, `readiness.service`, `region.service`, `server.service`, `steam.service`, `streams.service`, `tournament-match-lineup.service`, `tournament.controller`, `tournament.service`, `typesense.service`, `workshop-maps.service`

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
