import { Test, TestingModule } from '@nestjs/testing';
import { MatchmakeService } from './matchmake.service';

describe('MatchmakeService', () => {
  let service: MatchmakeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchmakeService],
    }).compile();

    service = module.get<MatchmakeService>(MatchmakeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
