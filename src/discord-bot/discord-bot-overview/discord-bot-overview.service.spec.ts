import { Test, TestingModule } from "@nestjs/testing";
import { DiscordBotOverviewService } from "./discord-bot-overview.service";

describe("DiscordBotOverviewService", () => {
  let service: DiscordBotOverviewService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordBotOverviewService],
    }).compile();

    service = module.get<DiscordBotOverviewService>(DiscordBotOverviewService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
