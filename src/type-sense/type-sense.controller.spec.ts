import { Test, TestingModule } from "@nestjs/testing";
import { TypeSenseController } from "./type-sense.controller";

describe("TypeSenseController", () => {
  let controller: TypeSenseController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TypeSenseController],
    }).compile();

    controller = module.get<TypeSenseController>(TypeSenseController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
