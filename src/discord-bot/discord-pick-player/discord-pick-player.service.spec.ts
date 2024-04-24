import { Test, TestingModule } from "@nestjs/testing";
import { DiscordPickPlayerService } from "./discord-pick-player.service";

describe("DiscordPickPlayerService", () => {
  let service: DiscordPickPlayerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordPickPlayerService],
    }).compile();

    service = module.get<DiscordPickPlayerService>(DiscordPickPlayerService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
