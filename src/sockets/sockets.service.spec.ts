import { Test, TestingModule } from "@nestjs/testing";
import { MatchSocketsService } from "./match-sockets.service";

describe("SocketsService", () => {
  let service: MatchSocketsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchSocketsService],
    }).compile();

    service = module.get<MatchSocketsService>(MatchSocketsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
