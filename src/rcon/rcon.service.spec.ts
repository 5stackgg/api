import { Test, TestingModule } from "@nestjs/testing";
import { RconService } from "./rcon.service";

describe("RconService", () => {
  let service: RconService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RconService],
    }).compile();

    service = module.get<RconService>(RconService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
