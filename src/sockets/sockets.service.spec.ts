import { Test, TestingModule } from "@nestjs/testing";
import { SocketsGateway } from "./sockets.gateway";

describe("SocketsService", () => {
  let service: SocketsGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SocketsGateway],
    }).compile();

    service = module.get<SocketsGateway>(SocketsGateway);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
