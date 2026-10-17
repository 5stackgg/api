import { PassThrough } from "stream";

let chunks: Array<string> = [];

jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({})),
  })),
  CoreV1Api: jest.fn(),
  BatchV1Api: jest.fn(),
  Log: jest.fn().mockImplementation(() => ({
    log: jest.fn(
      async (
        _namespace: string,
        _pod: string,
        _container: string,
        stream: PassThrough,
      ) => {
        setImmediate(() => {
          for (const chunk of chunks) {
            stream.write(chunk);
          }
          stream.end();
        });
        return { abort: jest.fn() };
      },
    ),
  })),
}));

import { LoggingService } from "./logging.service";

const pod = {
  metadata: { name: "api-1" },
  spec: { nodeName: "node-1", containers: [{ name: "api" }] },
} as any;

async function readLines(): Promise<Array<{ timestamp: string; log: string }>> {
  const service = new LoggingService({
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any);
  const out = new PassThrough();
  const lines: Array<{ timestamp: string; log: string }> = [];
  out.on("data", (data) => {
    const entry = JSON.parse(data.toString());
    if (entry.log !== undefined) {
      lines.push(entry);
    }
  });
  const ended = new Promise((resolve) => out.on("end", resolve));
  await service.getLogsForPod(pod, out, false, false, undefined, 250);
  await ended;
  return lines;
}

describe("LoggingService log lines", () => {
  it("keeps a line whole when a chunk ends in the middle of it", async () => {
    chunks = [
      "2026-10-17T21:00:00.000000000Z first line\n2026-10-17T21:00:01.0000",
      "00000Z second line, split across chunks\n",
    ];

    const lines = await readLines();

    expect(lines.map((line) => line.log.trim())).toEqual([
      "first line",
      "second line, split across chunks",
    ]);
    expect(lines[1].timestamp).toBe("2026-10-17T21:00:01.000000000Z");
  });

  it("keeps a last line that has no newline, and skips blank ones", async () => {
    chunks = [
      "2026-10-17T21:00:00.000000000Z one\n\n   \n",
      "2026-10-17T21:00:02.000000000Z two",
    ];

    const lines = await readLines();

    expect(lines.map((line) => line.log.trim())).toEqual(["one", "two"]);
  });
});
