import { TypeSenseConfig } from "./types/TypeSenseConfig";

export default (): {
  typesense: TypeSenseConfig;
} => ({
  typesense: {
    apiKey: process.env.TYPESENSE_API_KEY,
  },
});
