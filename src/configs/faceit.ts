import { FaceitConfig } from "./types/FaceitConfig";

export default (): {
  faceit: FaceitConfig;
} => ({
  faceit: {
    apiKey: process.env.FACEIT_API_KEY,
  },
});
