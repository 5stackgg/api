import { Test, TestingModule } from "@nestjs/testing";
import { LoggingServiceService } from "./logging-service.service";

describe("LoggingServiceService", () => {
  let service: LoggingServiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LoggingServiceService],
    }).compile();

    service = module.get<LoggingServiceService>(LoggingServiceService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
