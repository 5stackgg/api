import { Test, TestingModule } from "@nestjs/testing";
import { DiscordBotVetoService } from "./discord-bot-veto.service";

describe("DiscordBotVetoService", () => {
  let service: DiscordBotVetoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordBotVetoService],
    }).compile();

    service = module.get<DiscordBotVetoService>(DiscordBotVetoService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
