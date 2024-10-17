import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { SystemService } from "./system.service";

@Controller("system")
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();
  }
}
