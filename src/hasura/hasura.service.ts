import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createClient,
  FieldsSelection,
  type mutation_root,
  type mutation_rootGenqlSelection,
  type query_root,
  type query_rootGenqlSelection,
} from "../../generated";
import { HasuraConfig } from "../configs/types/HasuraConfig";

@Injectable()
export class HasuraService {
  private config: HasuraConfig;

  constructor(readonly configService: ConfigService) {
    this.config = configService.get<HasuraConfig>("hasura");
  }

  public async query<R extends query_rootGenqlSelection>(
    request: R & { __name?: string },
  ): Promise<FieldsSelection<query_root, R>> {
    try {
      return await this.getClient().query(request);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  public async mutation<R extends mutation_rootGenqlSelection>(
    request: R & { __name?: string },
  ): Promise<FieldsSelection<mutation_root, R>> {
    try {
      return await this.getClient().mutation(request);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  private getClient() {
    return createClient({
      url: `${this.config.endpoint}/v1/graphql`,
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": this.config.secret,
      },
    });
  }
}
