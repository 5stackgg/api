import { Test, TestingModule } from "@nestjs/testing";
import { SocketsService } from "./sockets.service";

describe("SocketsService", () => {
  let service: SocketsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SocketsService],
    }).compile();

    service = module.get<SocketsService>(SocketsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
