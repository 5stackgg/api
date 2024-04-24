import { Test, TestingModule } from "@nestjs/testing";
import { ServerGateway } from "./server.gateway";

describe("ServerGateway", () => {
  let gateway: ServerGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ServerGateway],
    }).compile();

    gateway = module.get<ServerGateway>(ServerGateway);
  });

  it("should be defined", () => {
    expect(gateway).toBeDefined();
  });
});
