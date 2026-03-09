import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "../src/app.module";
import { HasuraService } from "../src/hasura/hasura.service";
import { TypeSenseService } from "../src/type-sense/type-sense.service";
import { SystemService } from "../src/system/system.service";
import { DiscordBotService } from "../src/discord-bot/discord-bot.service";

/**
 * Creates a mock Hasura query result via Proxy. Collections return empty
 * arrays; aggregate queries return count > 0 to skip data-generation
 * bootstrap logic (e.g. MatchesModule.generatePlayerRatings).
 */
function createMockQueryResult(): any {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === "string") {
          if (prop.includes("aggregate")) {
            return { aggregate: { count: 1 } };
          }
          return [];
        }
        return undefined;
      },
    },
  );
}

export const mockHasuraService = {
  query: jest
    .fn()
    .mockImplementation(() => Promise.resolve(createMockQueryResult())),
  mutation: jest.fn().mockResolvedValue({}),
  setup: jest.fn().mockResolvedValue(undefined),
  checkSecret: jest.fn().mockReturnValue(false),
  getHasuraHeaders: jest.fn().mockResolvedValue({}),
};

export const mockTypeSenseService = {
  setup: jest.fn().mockResolvedValue(undefined),
  updatePlayer: jest.fn().mockResolvedValue(undefined),
  removePlayer: jest.fn().mockResolvedValue(undefined),
  upsertCvars: jest.fn().mockResolvedValue(undefined),
  resetCvars: jest.fn().mockResolvedValue(undefined),
  createPlayerCollection: jest.fn().mockResolvedValue(undefined),
  createCvarsCollection: jest.fn().mockResolvedValue(undefined),
};

export const mockSystemService = {
  detectFeatures: jest.fn().mockResolvedValue(undefined),
  getSetting: jest
    .fn()
    .mockImplementation((_name, defaultValue) =>
      Promise.resolve(defaultValue),
    ),
};

export const mockDiscordBotService = {
  setup: jest.fn().mockResolvedValue(undefined),
  login: jest.fn().mockResolvedValue(undefined),
  client: null,
};

/**
 * Creates a NestJS test application with external services mocked out.
 *
 * Mocked services (not available in test CI):
 *  - HasuraService  → prevents GraphQL fetches to non-existent Hasura
 *  - TypeSenseService → prevents infinite retry loop to typesense:8108
 *  - SystemService  → prevents K8s config loading + infinite detectFeatures loop
 *  - DiscordBotService → prevents Discord API calls
 *
 * Uses WsAdapter to match src/main.ts bootstrap.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(HasuraService)
    .useValue(mockHasuraService)
    .overrideProvider(TypeSenseService)
    .useValue(mockTypeSenseService)
    .overrideProvider(SystemService)
    .useValue(mockSystemService)
    .overrideProvider(DiscordBotService)
    .useValue(mockDiscordBotService)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.init();

  return app;
}
