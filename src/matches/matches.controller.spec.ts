import { Test, TestingModule } from "@nestjs/testing";
import { MatchesController } from "./matches.controller";

describe("MatchesController", () => {
  let controller: MatchesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MatchesController],
    }).compile();

    controller = module.get<MatchesController>(MatchesController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
