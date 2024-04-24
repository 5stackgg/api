import { Chain, ValueTypes } from "../../generated/zeus";
import { Injectable } from "@nestjs/common";

@Injectable()
export class HasuraService {
  public async query<Z extends ValueTypes["query_root"]>(
    gql: Z | ValueTypes["query_root"]
  ) {
    return await this.getClient()("query", {
      scalars: {
        uuid: {
          decode: (value: string) => {
            return value;
          },
        },
        bigint: {
          decode: (value: string) => {
            return BigInt(value);
          },
        },
      },
    })(gql);
  }

  public async mutation<Z extends ValueTypes["mutation_root"]>(
    gql: Z | ValueTypes["mutation_root"],
    variables?: Record<string, unknown>
  ) {
    return await this.getClient()("mutation", {
      scalars: {
        uuid: {
          decode: (value: string) => {
            return value;
          },
        },
        bigint: {
          encode: (value: string) => {
            return value.toString();
          },
        },
      },
    })(gql, { variables });
  }

  private getClient() {
    return Chain(`${process.env.HASURA_GRAPHQL_ENDPOINT}/v1/graphql`, {
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": process.env.HASURA_GRAPHQL_ADMIN_SECRET,
      },
    });
  }
}
