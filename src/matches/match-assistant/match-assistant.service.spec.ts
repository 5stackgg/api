import { Test, TestingModule } from "@nestjs/testing";
import { MatchAssistantService } from "./match-assistant.service";

describe("MatchAssistantService", () => {
  let service: MatchAssistantService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchAssistantService],
    }).compile();

    service = module.get<MatchAssistantService>(MatchAssistantService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
