import { Client } from "pg";

const TEST_DB_CONFIG = {
  host: "localhost",
  port: 5433,
  database: "hasura_test",
  user: "hasura",
  password: "test_password",
};

export async function seedTestDatabase() {
  const client = new Client(TEST_DB_CONFIG);
  await client.connect();

  try {
    // Insert match type enums
    await client.query(`
      INSERT INTO e_match_types (value, description) VALUES
        ('Competitive', 'Standard 5v5'),
        ('Wingman', '2v2'),
        ('Duel', '1v1')
      ON CONFLICT DO NOTHING;
    `);

    // Insert test maps
    await client.query(`
      INSERT INTO maps (id, name, type, active) VALUES
        ('11111111-1111-1111-1111-111111111111', 'de_dust2', 'Competitive', true),
        ('22222222-2222-2222-2222-222222222222', 'de_mirage', 'Competitive', true)
      ON CONFLICT DO NOTHING;
    `);

    // Insert test map pool
    await client.query(`
      INSERT INTO map_pools (id, name, type) VALUES
        ('33333333-3333-3333-3333-333333333333', 'Test Pool', 'Competitive')
      ON CONFLICT DO NOTHING;
    `);

    // Insert test players
    await client.query(`
      INSERT INTO players (steam_id, name, role) VALUES
        (76561198000000001, 'TestAdmin', 'administrator'),
        (76561198000000002, 'TestOrganizer', 'match_organizer'),
        (76561198000000003, 'TestPlayer', 'user')
      ON CONFLICT DO NOTHING;
    `);

    console.log("[Seed] Test database seeded successfully.");
  } finally {
    await client.end();
  }
}

export async function cleanTestDatabase() {
  const client = new Client(TEST_DB_CONFIG);
  await client.connect();

  try {
    await client.query(
      "TRUNCATE matches, match_lineups, match_maps CASCADE",
    );
    console.log("[Seed] Test database cleaned.");
  } catch {
    // Tables may not exist yet if migrations haven't run
    console.warn("[Seed] Could not truncate tables (migrations may be pending).");
  } finally {
    await client.end();
  }
}
