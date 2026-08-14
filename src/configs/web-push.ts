import { WebPushConfig } from "./types/WebPushConfig";

export default (): {
  webPush: WebPushConfig;
} => ({
  webPush: {
    publicKey: process.env.WEB_PUSH_PUBLIC_KEY,
    privateKey: process.env.WEB_PUSH_PRIVATE_KEY,
    // VAPID requires a contact the push service can reach if a subscription
    // starts misbehaving. A URL is as valid as a mailto: here.
    subject: process.env.WEB_PUSH_SUBJECT || `https://${process.env.WEB_DOMAIN}`,
  },
});
