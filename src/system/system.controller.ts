import { Controller } from "@nestjs/common";
import { SystemService } from "./system.service";
import { HasuraAction } from "src/hasura/hasura.controller";

@Controller("system")
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();

    return {
      success: true,
    };
  }
}
