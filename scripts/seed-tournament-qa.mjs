#!/usr/bin/env node
// Seeds one tournament per state of the check-in / free-agent / join-rules
// features, so every surface can be clicked through without waiting on a clock.
//
// Run from the api repo so it picks up the same POSTGRES_* vars the app uses:
//   node seed-tournament-qa.mjs           seed (wipes previous [QA] data first)
//   node seed-tournament-qa.mjs --clean   remove all [QA] data and exit
//
// Everything it creates is prefixed "[QA]" and owned by synthetic players in a
// reserved steam-id block, so a wipe can never touch real data.

import pg from "pg";

const PREFIX = "[QA]";
const STEAM_BASE = 76500000000000000n; // reserved block for synthetic players

const pool = new pg.Pool({
  user: process.env.POSTGRES_USER || "hasura",
  password: process.env.POSTGRES_PASSWORD || "hasura",
  host: process.env.POSTGRES_HOST || "localhost",
  port: process.env.POSTGRES_SERVICE_PORT
    ? parseInt(process.env.POSTGRES_SERVICE_PORT)
    : 5432,
  database: process.env.POSTGRES_DB || "hasura",
});

let steamSeq = 0;
let REGION = null;
const nextSteam = () => (STEAM_BASE + BigInt(++steamSeq)).toString();

// Hasura sets this GUC per request; triggers read it to identify the actor.
// Transaction-local so it cannot leak onto a pooled connection.
async function asUser(client, steamId, role, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('hasura.user', $1, true)", [
      JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId }),
    ]);
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function clean(client) {
  await client.query(
    `DELETE FROM matches WHERE id IN (
       SELECT tb.match_id FROM tournament_brackets tb
       JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       JOIN tournaments t ON t.id = ts.tournament_id
       WHERE t.name LIKE $1 AND tb.match_id IS NOT NULL)`,
    [PREFIX + "%"],
  );
  await client.query("DELETE FROM tournaments WHERE name LIKE $1", [PREFIX + "%"]);
  await client.query("DELETE FROM players WHERE steam_id >= $1", [STEAM_BASE.toString()]);
}

// Seeding a bracket schedules matches, and tbi_match -> sanitize_match_options_regions
// refuses a match when no region has an attached, enabled server. On a real dev
// stack one already exists; on a bare database it does not, so make sure of it.
// Returns the region name to pin the tournaments' match_options to.
async function ensureRegion(client) {
  const existing = await client.query(
    `SELECT region FROM servers WHERE enabled = true AND region IS NOT NULL LIMIT 1`,
  );
  if (existing.rows.length) {
    return existing.rows[0].region;
  }
  const region = "QA";
  await client.query(
    `INSERT INTO server_regions (value, description) VALUES ($1, $1)
     ON CONFLICT (value) DO NOTHING`,
    [region],
  );
  await client.query(
    `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
     VALUES ('127.0.0.1', $1, $2, 27015, $1, 'Ranked', true, true)`,
    [region, Buffer.from("password")],
  );
  return region;
}

async function player(client, name, role = "verified_user") {
  const steamId = nextSteam();
  await client.query(
    `INSERT INTO players (steam_id, name, role) VALUES ($1, $2, $3)
     ON CONFLICT (steam_id) DO NOTHING`,
    [steamId, `${PREFIX} ${name}`, role],
  );
  return steamId;
}

// Wingman (2v2) keeps rosters small so a seeded tournament is quick to read.
async function tournament(client, { name, organizer, startsInMinutes, columns = {} }) {
  const [{ id: optionsId }] = (
    await client.query(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, true, ARRAY[$1]
       FROM map_pools WHERE type = 'Wingman' AND seed = true LIMIT 1
       RETURNING id`,
      [REGION],
    )
  ).rows;

  const cols = Object.keys(columns);
  const [{ id }] = (
    await client.query(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status
              ${cols.length ? "," + cols.map((c) => `"${c}"`).join(",") : ""})
       VALUES ($1, now() + ($2 || ' minutes')::interval, $3, $4, 'Setup'
              ${cols.map((_, i) => `$${5 + i}`).join(",") ? "," + cols.map((_, i) => `$${5 + i}`).join(",") : ""})
       RETURNING id`,
      [`${PREFIX} ${name}`, String(startsInMinutes), organizer, optionsId,
        ...cols.map((c) => columns[c])],
    )
  ).rows;

  await client.query(
    `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
     VALUES ($1, 'SingleElimination', 1, 4, 8)`,
    [id],
  );
  return id;
}

async function setStatus(client, id, organizer, status) {
  await asUser(client, organizer, "admin", () =>
    client.query("UPDATE tournaments SET status = $1 WHERE id = $2", [status, id]),
  );
}

// Pickup team (team_id NULL) + roster, inserted as admin so the roster trigger
// does not redirect the members into invites.
async function registerTeam(client, tournamentId, organizer, name, members, checkedIn) {
  return asUser(client, organizer, "admin", async () => {
    const [{ id }] = (
      await client.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id, checked_in_at)
         VALUES ($1, $2, $3, $3, $4) RETURNING id`,
        [tournamentId, name, members[0], checkedIn ? new Date() : null],
      )
    ).rows;
    for (const steamId of members) {
      await client.query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, steamId, tournamentId],
      );
    }
    // tbi_tournament_team auto-stamps checked_in_at when the window is already
    // open, which is right in production (a team can't be a no-show for a prompt
    // it never saw) but defeats seeding a team that is deliberately NOT checked
    // in. Undo it explicitly for those.
    if (!checkedIn) {
      await client.query(
        "UPDATE tournament_teams SET checked_in_at = NULL WHERE id = $1", [id]);
    }
    return id;
  });
}

async function team(client, tournamentId, organizer, label, checkedIn) {
  const members = [
    await player(client, `${label} cap`),
    await player(client, `${label} mate`),
  ];
  return registerTeam(client, tournamentId, organizer, `${PREFIX} ${label}`, members, checkedIn);
}

const scenarios = [];
const record = (name, id, note) => scenarios.push({ name, id, note });

async function main() {
  const client = await pool.connect();
  const cleanOnly = process.argv.includes("--clean");
  try {
    await clean(client);
    if (cleanOnly) {
      console.log("cleaned all [QA] data");
      return;
    }
    REGION = await ensureRegion(client);

    // 1. control — check-in off, behaves exactly as today
    {
      const org = await player(client, "org control", "tournament_organizer");
      const id = await tournament(client, { name: "1 control (no check-in)", organizer: org, startsInMinutes: 180 });
      await setStatus(client, id, org, "RegistrationOpen");
      for (const l of ["Alpha", "Bravo", "Charlie", "Delta"]) await team(client, id, org, l, false);
      record("control, check-in OFF", id, "registration open, 4 teams, nothing new should appear");
    }

    // 2. check-in on, window has NOT opened yet
    {
      const org = await player(client, "org pending", "tournament_organizer");
      const id = await tournament(client, {
        name: "2 check-in not open", organizer: org, startsInMinutes: 240,
        columns: { check_in_required: true, check_in_opens_before_minutes: 60, check_in_closes_before_minutes: 15 },
      });
      await setStatus(client, id, org, "RegistrationOpen");
      for (const l of ["Alpha", "Bravo", "Charlie", "Delta"]) await team(client, id, org, l, false);
      record("check-in PENDING", id, "starts in 4h, window opens at T-60 -> prompt should say 'opens in ~3h'");
    }

    // 3. window OPEN right now, one team in, one not
    {
      const org = await player(client, "org open", "tournament_organizer");
      const id = await tournament(client, {
        name: "3 check-in open now", organizer: org, startsInMinutes: 30,
        columns: { check_in_required: true, check_in_opens_before_minutes: 60, check_in_closes_before_minutes: 15 },
      });
      await setStatus(client, id, org, "RegistrationOpen");
      await team(client, id, org, "Checked A", true);
      await team(client, id, org, "Checked B", true);
      await team(client, id, org, "Waiting A", false);
      await team(client, id, org, "Waiting B", false);
      await client.query(
        `UPDATE tournaments SET check_in_ends_at = start - interval '15 minutes' WHERE id = $1`, [id]);
      record("check-in OPEN", id, "window is live, closes at T-15 -> countdown + Check In button, schedule fields locked");
    }

    // 4. Players mode, partial confirmations
    {
      const org = await player(client, "org players", "tournament_organizer");
      const id = await tournament(client, {
        name: "4 check-in players mode", organizer: org, startsInMinutes: 30,
        columns: { check_in_required: true, check_in_setting: "Players", check_in_opens_before_minutes: 60, check_in_closes_before_minutes: 15 },
      });
      await setStatus(client, id, org, "RegistrationOpen");
      const teamId = await team(client, id, org, "Partial", false);
      for (const l of ["Full A", "Full B", "Full C"]) await team(client, id, org, l, true);
      await client.query(
        `UPDATE tournament_team_roster SET checked_in_at = now()
         WHERE tournament_team_id = $1 AND player_steam_id = (
           SELECT MIN(player_steam_id) FROM tournament_team_roster WHERE tournament_team_id = $1)`,
        [teamId],
      );
      await client.query(
        `UPDATE tournaments SET check_in_ends_at = start - interval '15 minutes' WHERE id = $1`, [id]);
      record("check-in PLAYERS mode", id, "1 of 2 players confirmed -> per-player rows, team not yet checked in");
    }

    // 5. CheckInReview — the held state with no-shows
    {
      const org = await player(client, "org review", "tournament_organizer");
      const id = await tournament(client, {
        name: "5 check-in review", organizer: org, startsInMinutes: 20,
        columns: { check_in_required: true, check_in_opens_before_minutes: 60, check_in_closes_before_minutes: 15 },
      });
      await setStatus(client, id, org, "RegistrationOpen");
      await team(client, id, org, "Showed A", true);
      await team(client, id, org, "Showed B", true);
      await team(client, id, org, "NoShow A", false);
      await team(client, id, org, "NoShow B", false);
      await client.query(
        `UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1`, [id]);
      await setStatus(client, id, org, "CheckInReview");
      record("CHECK-IN REVIEW (held)", id, "2 no-shows, rosters intact -> Re-admit / Extend / Continue panel");
    }

    // 6. free agents, pool open
    {
      const org = await player(client, "org agents", "tournament_organizer");
      const id = await tournament(client, {
        name: "6 free agents pool", organizer: org, startsInMinutes: 180,
        columns: { registration_type: "free_agents" },
      });
      await setStatus(client, id, org, "RegistrationOpen");
      for (let i = 1; i <= 9; i++) {
        const p = await player(client, `agent ${i}`);
        await client.query(
          `INSERT INTO tournament_free_agents (tournament_id, player_steam_id, created_at)
           VALUES ($1, $2, now() - ($3 || ' minutes')::interval)`,
          [id, p, String(60 - i * 5)],
        );
      }
      record("FREE AGENTS pool", id, "9 signed up -> 4 teams of 2, 1 waitlisted. Try Regenerate Teams");
    }

    // 7. join rules — role + ELO + invite only
    {
      const org = await player(client, "org gated", "tournament_organizer");
      const id = await tournament(client, {
        name: "7 join rules", organizer: org, startsInMinutes: 300,
        columns: {
          min_role: "verified_user", min_elo: 1200, max_elo: 2000,
          invite_only: true, registration_passcode: "QA-2026",
          regions: "{}",
        },
      });
      await setStatus(client, id, org, "RegistrationOpen");
      record("JOIN RULES", id, "verified_user + 1200-2000 ELO + invite only, passcode QA-2026");
    }

    console.log(`\nSeeded ${scenarios.length} scenarios:\n`);
    for (const s of scenarios) {
      console.log(`  ${s.name}`);
      console.log(`    /tournaments/${s.id}`);
      console.log(`    ${s.note}\n`);
    }
    console.log("Re-run to reset. --clean removes everything.\n");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("\nseed failed:", e.message);
  process.exitCode = 1;
});
