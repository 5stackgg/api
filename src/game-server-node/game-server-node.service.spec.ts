import { Test, TestingModule } from "@nestjs/testing";
import { GameServerNodeService } from "./game-server-node.service";

describe("GameServerNodeService", () => {
  let service: GameServerNodeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GameServerNodeService],
    }).compile();

    service = module.get<GameServerNodeService>(GameServerNodeService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
