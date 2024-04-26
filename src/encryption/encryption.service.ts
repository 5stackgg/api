import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from "@nestjs/config";
import { readMessage, decrypt } from "openpgp";
import { AppConfig } from "../configs/types/AppConfig";

@Injectable()
export class EncryptionService {
  private appKey: string;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService
  ) {
    this.appKey = this.config.get<AppConfig>("app").appKey;
  }

  /**
   * hasura converts bytea to hex prefix with \\x
   */
  public async decrypt(encryptedHex: string) {
    try {
      const encryptedMessage = await readMessage({
        binaryMessage: this.hexStringToUint8Array(
          encryptedHex.replace("\\x", "")
        ),
      });

      const { data: decryptedData } = await decrypt({
        format: "utf8",
        message: encryptedMessage,
        passwords: [this.appKey],
      });

      // utf8 returns as a string
      return decryptedData as string;
    } catch (error) {
      this.logger.error("Error decrypting data:", error);
      throw error;
    }
  }

  private hexStringToUint8Array(hexString: string): Uint8Array {
    const buffer = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      buffer[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return buffer;
  }
}
