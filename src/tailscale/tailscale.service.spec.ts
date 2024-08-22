import { Test, TestingModule } from "@nestjs/testing";
import { TailscaleService } from "./tailscale.service";

describe("TailscaleService", () => {
  let service: TailscaleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TailscaleService],
    }).compile();

    service = module.get<TailscaleService>(TailscaleService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
