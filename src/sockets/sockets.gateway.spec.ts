import { Test, TestingModule } from "@nestjs/testing";
import { SocketsGateway } from "./sockets.gateway";

describe("ServerGateway", () => {
  let gateway: SocketsGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SocketsGateway],
    }).compile();

    gateway = module.get<SocketsGateway>(SocketsGateway);
  });

  it("should be defined", () => {
    expect(gateway).toBeDefined();
  });
});
