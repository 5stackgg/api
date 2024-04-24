import { Test, TestingModule } from "@nestjs/testing";
import { QuickConnectController } from "./quick-connect.controller";

describe("QuickConnectController", () => {
  let controller: QuickConnectController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QuickConnectController],
    }).compile();

    controller = module.get<QuickConnectController>(QuickConnectController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
