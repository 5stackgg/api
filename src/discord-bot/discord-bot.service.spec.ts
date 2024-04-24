import { Test, TestingModule } from "@nestjs/testing";
import { DiscordBotService } from "./discord-bot.service";

describe("DiscordBotService", () => {
  let service: DiscordBotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordBotService],
    }).compile();

    service = module.get<DiscordBotService>(DiscordBotService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
