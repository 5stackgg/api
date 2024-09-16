import { ModuleRef } from "@nestjs/core";
import { Logger, Injectable } from "@nestjs/common";
import {
  ButtonInteraction,
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { ChatCommands } from "./enums/ChatCommands";
import { HasuraService } from "../hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { DiscordConfig } from "../configs/types/DiscordConfig";
import { e_map_pool_types_enum } from "../../generated";
import { interactions } from "./interactions/interactions";
import DiscordInteraction from "./interactions/abstracts/DiscordInteraction";

let client: Client;

@Injectable()
export class DiscordBotService {
  public client: Client;
  private discordConfig: DiscordConfig;

  constructor(
    readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.client = client;
    this.discordConfig = config.get<DiscordConfig>("discord");
  }

  public async login() {
    client = this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.client
      .on("ready", () => {
        this.logger.log(`logged in as ${this.client.user.tag}!`);
      })
      .on("interactionCreate", async (interaction) => {
        if (interaction.isChatInputCommand()) {
          const DiscordInteraction =
            interactions.chat[
              interaction.commandName as keyof typeof interactions.chat
            ];

          return await this.moduleRef
            .get<
              symbol,
              DiscordInteraction
            >(DiscordInteraction as unknown as symbol)
            .handler(interaction);
        }

        if (interaction.isButton()) {
          const [type] = (interaction as ButtonInteraction).customId.split(":");
          const DiscordInteraction =
            interactions.buttons[type as keyof typeof interactions.buttons];

          return await this.moduleRef
            .get<
              symbol,
              DiscordInteraction
            >(DiscordInteraction as unknown as symbol)
            .handler(interaction);
        }
      })
      .on("error", (error) => {
        this.logger.warn("unhandled error", error);
      });

    await this.client.login(this.discordConfig.token);
  }

  public async setupBot() {
    if (!this.discordConfig.token) {
      this.logger.warn("discord bot not configured");
      return;
    }

    const rest = new REST({ version: "10" }).setToken(this.discordConfig.token);

    try {
      await rest.put(Routes.applicationCommands(this.discordConfig.clientId), {
        body: [
          await this.addBaseOptions(
            new SlashCommandBuilder()
              .setName(ChatCommands.ScheduleComp)
              .setDescription("Creates a Competitive Match"),
          ),
          await this.addBaseOptions(
            new SlashCommandBuilder()
              .setName(ChatCommands.ScheduleWingMan)
              .setDescription("Creates a Wingman Match"),
          ),
        ],
      });

      await this.login();

      this.logger.debug("successfully reloaded application (/) interactions.");
    } catch (error) {
      this.logger.error(`unable to reload application (/) commands`, error);
    }
  }

  private async addBaseOptions(builder: SlashCommandBuilder) {
    const mapChoices = await this.getMapChoices("Competitive");

    return builder
      .addChannelOption((option) =>
        option
          .setName("team-selection")
          .setDescription(
            "This channel should have at least 10 or 4 people to start a match based on the type.",
          )
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice),
      )
      .addBooleanOption((option) =>
        option
          .setName("knife")
          .setDescription("Knife Round to pick sides (default: true)"),
      )
      .addBooleanOption((option) =>
        option
          .setName("overtime")
          .setDescription("Allow Overtime (default: true)"),
      )
      .addStringOption((option) =>
        option
          .setName("map")
          .setDescription("override map")
          .addChoices(...mapChoices),
      )
      .addBooleanOption((option) =>
        option
          .setName("captains")
          .setDescription("Captain Picks (default: true)"),
      )
      .addUserOption((option) =>
        option.setName("captain-1").setDescription("Captain #1"),
      )
      .addUserOption((option) =>
        option.setName("captain-2").setDescription("Captain #2"),
      )
      .addBooleanOption((option) =>
        option
          .setName("on-demand-server")
          .setDescription(
            "Use On Demand Server. If disabled, it will ask to use one of your servers (default: true)",
          ),
      )
      .addStringOption((option) =>
        option
          .setName("mr")
          .setDescription("Sets the number of rounds per half (default MR12)")
          .addChoices(
            { name: "MR3", value: "3" },
            { name: "MR8", value: "8" },
            { name: "MR12", value: "12" },
            { name: "MR15", value: "15" },
          ),
      );
  }

  private async getMapChoices(type: e_map_pool_types_enum) {
    const { map_pools } = await this.hasura.query({
      map_pools: {
        type: true,
        maps: {
          id: true,
          name: true,
        },
      },
    });

    const map_pool = map_pools.find((pool) => {
      return pool.type === type;
    });

    if (!map_pool) {
      throw Error("not able to find map pool");
    }

    return map_pool.maps.map((map) => {
      return {
        name: map.name,
        value: map.id,
      };
    });
  }
}
