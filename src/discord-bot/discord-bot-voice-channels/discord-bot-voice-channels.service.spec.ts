import { Test, TestingModule } from "@nestjs/testing";
import { DiscordBotVoiceChannelsService } from "./discord-bot-voice-channels.service";

describe("DiscordBotVoiceChannelsService", () => {
  let service: DiscordBotVoiceChannelsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordBotVoiceChannelsService],
    }).compile();

    service = module.get<DiscordBotVoiceChannelsService>(
      DiscordBotVoiceChannelsService
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
