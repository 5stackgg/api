import { Test, TestingModule } from "@nestjs/testing";
import { BackupRoundsController } from "./backup-rounds.controller";

describe("BackupRoundsController", () => {
  let controller: BackupRoundsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupRoundsController],
    }).compile();

    controller = module.get<BackupRoundsController>(BackupRoundsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
