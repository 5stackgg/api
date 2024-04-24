import { Test, TestingModule } from "@nestjs/testing";
import { ActionsController } from "./actions.controller";

describe("ActionsController", () => {
  let controller: ActionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActionsController],
    }).compile();

    controller = module.get<ActionsController>(ActionsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
