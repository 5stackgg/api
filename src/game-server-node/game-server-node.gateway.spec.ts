import { Test, TestingModule } from "@nestjs/testing";
import { GameServerNodeGateway } from "./game-server-node.gateway";

describe("GameServerNodeGateway", () => {
  let gateway: GameServerNodeGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GameServerNodeGateway],
    }).compile();

    gateway = module.get<GameServerNodeGateway>(GameServerNodeGateway);
  });

  it("should be defined", () => {
    expect(gateway).toBeDefined();
  });
});
