import { Test, TestingModule } from "@nestjs/testing";
import { PostgresController } from "./postgres.controller";

describe("PostgresController", () => {
  let controller: PostgresController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PostgresController],
    }).compile();

    controller = module.get<PostgresController>(PostgresController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
