import { Test, TestingModule } from "@nestjs/testing";
import { TypeSenseService } from "./type-sense.service";

describe("TypeSenseService", () => {
  let service: TypeSenseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TypeSenseService],
    }).compile();

    service = module.get<TypeSenseService>(TypeSenseService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
