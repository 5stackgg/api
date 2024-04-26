import { Chain, ValueTypes, ZeusScalars } from "../../generated/zeus";
import { Injectable } from "@nestjs/common";

const scalars = ZeusScalars({
  uuid: {
    decode: (value: string) => {
      return value;
    },
  },
  bigint: {
    encode: (value: string) => {
      return value.toString();
    },
    decode: (value: string) => {
      return BigInt(value);
    },
  },
});

@Injectable()
export class HasuraService {
  public async query<Z extends ValueTypes["query_root"]>(
    gql: Z | ValueTypes["query_root"]
  ) {
    return await this.getClient()("query", {
      scalars,
    })(gql);
  }

  public async mutation<Z extends ValueTypes["mutation_root"]>(
    gql: Z | ValueTypes["mutation_root"],
    variables?: Record<string, unknown>
  ) {
    return await this.getClient()("mutation", {
      scalars,
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
