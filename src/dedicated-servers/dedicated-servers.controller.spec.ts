import { Test, TestingModule } from "@nestjs/testing";
import { DedicatedServersController } from "./dedicated-servers.controller";

describe("DedicatedServersController", () => {
  let controller: DedicatedServersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DedicatedServersController],
    }).compile();

    controller = module.get<DedicatedServersController>(
      DedicatedServersController,
    );
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
