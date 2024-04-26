import { HasuraConfig } from "./types/HasuraConfig";

export default (): {
  hasura: HasuraConfig;
} => ({
  hasura: {
    endpoint: process.env.HASURA_GRAPHQL_ENDPOINT,
    secret: process.env.HASURA_GRAPHQL_ADMIN_SECRET,
  },
});
