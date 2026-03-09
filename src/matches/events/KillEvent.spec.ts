jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import KillEvent from "./KillEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = {};
  const chat = {};
  const event = new KillEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura };
}

describe("KillEvent", () => {
  it("inserts kill with full attacker data when attacker_steam_id is present", async () => {
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 2,
      attacker_steam_id: BigInt("76561198000000001"),
      attacker_team: "CT",
      attacker_location: "MidDoors",
      attacker_location_coordinates: "100.0 200.0 0.0",
      weapon: "ak47",
      hitgroup: "head",
      attacked_steam_id: BigInt("76561198000000002"),
      attacked_team: "TERRORIST",
      attacked_location: "BombsiteA",
      attacked_location_coordinates: "300.0 400.0 0.0",
      match_map_id: "map-1",
      no_scope: false,
      blinded: false,
      thru_smoke: true,
      thru_wall: false,
      headshot: true,
      assisted: false,
      in_air: false,
    });

    await event.process();

    expect(hasura.mutation).toHaveBeenCalledWith({
      insert_player_kills_one: {
        __args: {
          object: {
            time: new Date("2026-01-01T00:00:00Z"),
            match_id: "match-1",
            match_map_id: "map-1",
            round: 2,
            with: "ak47",
            no_scope: false,
            blinded: false,
            thru_smoke: true,
            thru_wall: false,
            in_air: false,
            headshot: true,
            assisted: false,
            attacker_steam_id: BigInt("76561198000000001"),
            attacker_team: "CT",
            attacker_location: "MidDoors",
            attacker_location_coordinates: "100.0 200.0 0.0",
            attacked_steam_id: BigInt("76561198000000002"),
            attacked_team: "TERRORIST",
            attacked_location: "BombsiteA",
            attacked_location_coordinates: "300.0 400.0 0.0",
            hitgroup: "head",
          },
        },
        __typename: true,
      },
    });
  });

  it("falls back to attacked_steam_id as attacker for self-damage", async () => {
    const attackedId = BigInt("76561198000000002");
    const { event, hasura } = createEvent({
      time: "2026-01-01T00:00:00Z",
      round: 2,
      attacker_steam_id: 0,
      attacker_team: "",
      attacker_location: "",
      attacker_location_coordinates: "",
      weapon: "world",
      hitgroup: "generic",
      attacked_steam_id: attackedId,
      attacked_team: "CT",
      attacked_location: "BombsiteB",
      attacked_location_coordinates: "500.0 600.0 0.0",
      match_map_id: "map-1",
      no_scope: false,
      blinded: false,
      thru_smoke: false,
      thru_wall: false,
      headshot: false,
      assisted: false,
      in_air: false,
    });

    await event.process();

    const call = hasura.mutation.mock.calls[0][0];
    const obj = call.insert_player_kills_one.__args.object;
    expect(obj.attacker_steam_id).toBe(attackedId);
    expect(obj).not.toHaveProperty("attacker_team");
    expect(obj).not.toHaveProperty("attacker_location");
    expect(obj).not.toHaveProperty("attacker_location_coordinates");
  });
});
