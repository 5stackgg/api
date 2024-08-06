import { Chain, ValueTypes, ZeusScalars } from "../../generated/zeus";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraConfig } from "../configs/types/HasuraConfig";

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
      return value;
    },
  },
});

@Injectable()
export class HasuraService {
  private config: HasuraConfig;

  constructor(readonly configService: ConfigService) {
    this.config = configService.get<HasuraConfig>("hasura");
  }

  public async query<Z extends ValueTypes["query_root"]>(
    gql: Z | ValueTypes["query_root"],
  ) {
    try {
      return await this.getClient()("query", {
        scalars,
      })(gql);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  public async mutation<Z extends ValueTypes["mutation_root"]>(
    gql: Z | ValueTypes["mutation_root"],
    variables?: Record<string, unknown>,
  ) {
    try {
      return await this.getClient()("mutation", {
        scalars,
      })(gql, { variables });
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  private getClient() {
    return Chain(`${this.config.endpoint}/v1/graphql`, {
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": this.config.secret,
      },
    });
  }
}
