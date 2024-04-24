import { Test, TestingModule } from "@nestjs/testing";
import { RedisManagerService } from "./redis-manager.service";

describe("RedisManagerService", () => {
  let service: RedisManagerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisManagerService],
    }).compile();

    service = module.get<RedisManagerService>(RedisManagerService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
