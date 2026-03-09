jest.mock("openpgp", () => ({
  readMessage: jest.fn(),
  decrypt: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";
import { readMessage, decrypt } from "openpgp";

const mockReadMessage = readMessage as jest.MockedFunction<typeof readMessage>;
const mockDecrypt = decrypt as jest.MockedFunction<typeof decrypt>;

function createService() {
  const config = {
    get: jest.fn().mockReturnValue({ appKey: "test-app-key" }),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  const service = new EncryptionService(logger, config as any);

  return { service, logger };
}

describe("EncryptionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("decrypt", () => {
    it("strips \\x prefix from Hasura hex", async () => {
      const { service } = createService();
      const fakeMessage = { type: "message" };

      mockReadMessage.mockResolvedValueOnce(fakeMessage as any);
      mockDecrypt.mockResolvedValueOnce({ data: "decrypted-value" } as any);

      await service.decrypt("\\x48656c6c6f");

      expect(mockReadMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          binaryMessage: expect.any(Uint8Array),
        }),
      );

      // Verify the hex was decoded correctly (48656c6c6f = "Hello")
      const callArg = mockReadMessage.mock.calls[0][0] as any;
      expect(callArg.binaryMessage).toEqual(
        new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
      );
    });

    it("calls openpgp decrypt with correct password", async () => {
      const { service } = createService();
      const fakeMessage = { type: "message" };

      mockReadMessage.mockResolvedValueOnce(fakeMessage as any);
      mockDecrypt.mockResolvedValueOnce({
        data: "decrypted-result",
      } as any);

      const result = await service.decrypt("aabbcc");

      expect(mockDecrypt).toHaveBeenCalledWith({
        format: "utf8",
        message: fakeMessage,
        passwords: ["test-app-key"],
      });
      expect(result).toBe("decrypted-result");
    });

    it("throws and logs on decryption failure", async () => {
      const { service, logger } = createService();

      mockReadMessage.mockRejectedValueOnce(new Error("bad data"));

      await expect(service.decrypt("invalid-hex")).rejects.toThrow("bad data");
      expect(logger.error).toHaveBeenCalledWith(
        "Error decrypting data:",
        expect.any(Error),
      );
    });
  });
});
