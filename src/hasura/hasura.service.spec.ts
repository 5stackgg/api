import { Test, TestingModule } from "@nestjs/testing";
import { HasuraService } from "./hasura.service";

describe("HasuraService", () => {
  let service: HasuraService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HasuraService],
    }).compile();

    service = module.get<HasuraService>(HasuraService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
