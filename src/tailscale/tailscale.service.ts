import OAuth from "oauth";
import { Injectable } from "@nestjs/common";
import fetch from "node-fetch";
import { ConfigService } from "@nestjs/config";
import { TailscaleConfig } from "../configs/types/TailscaleConfig";

@Injectable()
export class TailscaleService {
  private config: TailscaleConfig;

  constructor(protected readonly configService: ConfigService) {
    this.config = this.configService.get("tailscale");
  }

  public async getAuthKey(): Promise<string> {
    const oauth2 = new OAuth.OAuth2(
      this.config.key,
      this.config.secret,
      "",
      "",
      "https://api.tailscale.com/api/v2/oauth/token",
    );

    const token = await new Promise((resolve, reject) => {
      oauth2.getOAuthAccessToken(
        "",
        { grant_type: "client_credentials" },
        function (error, access_token) {
          if (error) {
            reject(error);
            return;
          }
          resolve(access_token);
        },
      );
    });

    try {
      const response = await fetch(
        `https://api.tailscale.com/api/v2/tailnet/${this.config.netName}/keys`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            capabilities: {
              devices: {
                create: {
                  reusable: false,
                  ephemeral: false,
                  preauthorized: true,
                  tags: ["tag:fivestack"],
                },
              },
              api: {
                read: true,
              },
            },
            expirySeconds: 3600,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to obtain Tailscale auth key. Status: ${response.status}`,
        );
      }

      const data = await response.json();
      const authKey = data.key;

      if (!authKey) {
        throw new Error("Auth key not found in the response.");
      }

      return authKey;
    } catch (error) {
      console.error("Error retrieving Tailscale auth key:", error);
      throw error;
    }
  }
}
