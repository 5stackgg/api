import { Test, TestingModule } from "@nestjs/testing";
import { DiscordBotMessagingService } from "./discord-bot-messaging.service";

describe("DiscordBotMessagingService", () => {
  let service: DiscordBotMessagingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordBotMessagingService],
    }).compile();

    service = module.get<DiscordBotMessagingService>(
      DiscordBotMessagingService,
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
