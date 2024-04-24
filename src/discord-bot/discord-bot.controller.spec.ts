import { Test, TestingModule } from "@nestjs/testing";
import { DiscordBotController } from "./discord-bot.controller";

describe("DiscordBotController", () => {
  let controller: DiscordBotController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiscordBotController],
    }).compile();

    controller = module.get<DiscordBotController>(DiscordBotController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
