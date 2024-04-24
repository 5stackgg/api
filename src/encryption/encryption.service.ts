import { Injectable } from "@nestjs/common";
import crypto from "crypto";

/**
 * +--------------------+-----------------------+----------------+----------------+
 *  | SALT               | Initialization Vector | Auth Tag       | Payload        |
 *  | Used to derive key | AES GCM XOR Init      | Data Integrity | Encrypted Data |
 *  | 64 Bytes, random   | 16 Bytes, random      | 16 Bytes       | (N-96) Bytes   |
 *  +--------------------+-----------------------+----------------+----------------+
 *
 * masterKey: the key used for encryption/decryption
 */

@Injectable()
export class EncryptionService {
  private appKey: string;

  constructor() {
    this.appKey = process.env.APP_KEY as string;
  }

  public encrypt(text: string, masterKey?: string) {
    try {
      if (!masterKey) {
        masterKey = this.appKey;
      }
      // random initialization vector
      const iv = crypto.randomBytes(16);

      // random salt
      const salt = crypto.randomBytes(64);

      // derive key: 32 byte key length - in assumption the masterKey is a cryptographic and NOT a password there is no need for
      const key = crypto.pbkdf2Sync(masterKey, salt, 2145, 32, "sha512");

      // AES 256 GCM Mode
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

      const encrypted = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
      ]);

      // extract the auth tag
      const tag = cipher.getAuthTag();

      return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
    } catch (error) {
      console.warn("unable to encrypt key", error.message);
    }
  }

  public decrypt(encryptedData: string, masterKey?: string) {
    try {
      if (!masterKey) {
        masterKey = this.appKey;
      }
      const bData = Buffer.from(encryptedData, "base64");

      // convert data to buffers
      const salt = bData.slice(0, 64);
      const iv = bData.slice(64, 80);
      const tag = bData.slice(80, 96);
      const text = bData.slice(96);

      // derive key using; 32 byte key length
      const key = crypto.pbkdf2Sync(masterKey, salt, 2145, 32, "sha512");

      // AES 256 GCM Mode
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      // encrypt the given text
      return decipher.update(text) + decipher.final("utf8");
    } catch (error) {
      console.warn("unable to decode", error.message);
    }
  }
}
