import { Test, TestingModule } from "@nestjs/testing";
import { DemosController } from "./demos.controller";

describe("DemosController", () => {
  let controller: DemosController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DemosController],
    }).compile();

    controller = module.get<DemosController>(DemosController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
