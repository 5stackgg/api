import { Test, TestingModule } from "@nestjs/testing";
import { SocketsController } from "./sockets.controller";

describe("SocketsController", () => {
  let controller: SocketsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SocketsController],
    }).compile();

    controller = module.get<SocketsController>(SocketsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
