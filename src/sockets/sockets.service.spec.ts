import { Test, TestingModule } from "@nestjs/testing";
import { MatchLobbyService } from "../matches/match-lobby.service";

describe("SocketsService", () => {
  let service: MatchLobbyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchLobbyService],
    }).compile();

    service = module.get<MatchLobbyService>(MatchLobbyService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
