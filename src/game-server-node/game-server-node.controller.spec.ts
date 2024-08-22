import { Test, TestingModule } from "@nestjs/testing";
import { GameServerNodeController } from "./game-server-node.controller";

describe("GameServerNodeController", () => {
  let controller: GameServerNodeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GameServerNodeController],
    }).compile();

    controller = module.get<GameServerNodeController>(GameServerNodeController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
