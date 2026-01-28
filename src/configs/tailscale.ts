import { TailscaleConfig } from "./types/TailscaleConfig";

export default (): {
  tailscale: TailscaleConfig;
} => ({
  tailscale: {
    key: process.env.TAILSCALE_CLIENT_ID,
    secret: process.env.TAILSCALE_SECRET_ID,
    netName: process.env.TAILSCALE_NET_NAME || "-",
  },
});
