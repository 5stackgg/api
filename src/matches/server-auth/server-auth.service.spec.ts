import { Test, TestingModule } from "@nestjs/testing";
import { ServerAuthService } from "./server-auth.service";

describe("ServerAuthService", () => {
  let service: ServerAuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ServerAuthService],
    }).compile();

    service = module.get<ServerAuthService>(ServerAuthService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
