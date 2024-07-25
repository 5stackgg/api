import { Test, TestingModule } from "@nestjs/testing";
import { TournamentsController } from "./tournaments.controller";

describe("TournamentsController", () => {
  let controller: TournamentsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TournamentsController],
    }).compile();

    controller = module.get<TournamentsController>(TournamentsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
