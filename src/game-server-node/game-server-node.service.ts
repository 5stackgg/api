import { Injectable } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { e_game_server_node_statuses_enum } from "../../generated";
import { KubeConfig, CoreV1Api, PatchUtils } from "@kubernetes/client-node";

@Injectable()
export class GameServerNodeService {
  constructor(
    protected readonly cache: CacheService,
    protected readonly hasura: HasuraService,
  ) {}

  public async create(
    node?: string,
    status: e_game_server_node_statuses_enum = "Setup",
  ) {
    const { insert_game_server_nodes_one } = await this.hasura.mutation({
      insert_game_server_nodes_one: {
        __args: {
          object: {
            id: node,
            region: "Lan",
            status: status,
          },
        },
        id: true,
      },
    });

    return insert_game_server_nodes_one;
  }

  // TODO - track offline
  public async updateStatus(
    node: string,
    publicIP: string,
    status: e_game_server_node_statuses_enum,
    start_port_range?: number,
    end_port_range?: number,
  ) {
    const { update_game_server_nodes_by_pk: gameServerNode } =
      await this.hasura.mutation({
        update_game_server_nodes_by_pk: {
          __args: {
            pk_columns: {
              id: node,
            },
            _set: {
              status,
              public_ip: publicIP,
            },
          },
          id: true,
          end_port_range: true,
          start_port_range: true,
        },
      });

    if (!gameServerNode) {
      return await this.create(node, status);
    }

    if (
      gameServerNode.start_port_range !== start_port_range ||
      gameServerNode.end_port_range !== end_port_range
    ) {
      await this.updatePorts(
        node,
        gameServerNode.start_port_range,
        gameServerNode.end_port_range,
      );
    }
  }

  public async updatePorts(
    nodeName: string,
    start_port_range: number,
    end_port_range: number,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const core = kc.makeApiClient(CoreV1Api);

    try {
      // Fetch the current node
      const { body: node } = await core.readNode(nodeName);

      await core.patchNode(
        nodeName,
        [
          {
            op: "replace",
            path: "/metadata/labels",
            value: {
              ...node.metadata.labels,
              ...{
                "5stack-ports": `${start_port_range}_${end_port_range}`,
                // '5stack-services': ,
              },
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { "Content-type": PatchUtils.PATCH_FORMAT_JSON_PATCH } },
      );
    } catch (error) {
      console.warn("unable to patch node", error);
    }
  }
}
