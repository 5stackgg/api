import { Test, TestingModule } from "@nestjs/testing";
import { DedicatedServersService } from "./dedicated-servers.service";

describe("DedicatedServersService", () => {
  let service: DedicatedServersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DedicatedServersService],
    }).compile();

    service = module.get<DedicatedServersService>(DedicatedServersService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
