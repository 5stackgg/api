import { Test, TestingModule } from "@nestjs/testing";
import { HasuraController } from "./hasura.controller";

describe("HasuraController", () => {
  let controller: HasuraController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HasuraController],
    }).compile();

    controller = module.get<HasuraController>(HasuraController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
