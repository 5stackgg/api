import { ModuleRef } from "@nestjs/core";
import { Logger, Injectable } from "@nestjs/common";
import {
  AutocompleteInteraction,
  ButtonInteraction,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { ChatCommands } from "./enums/ChatCommands";
import { HasuraService } from "../hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { DiscordConfig } from "../configs/types/DiscordConfig";
import { e_match_types_enum } from "../../generated";
import { interactions } from "./interactions/interactions";
import DiscordInteraction from "./interactions/abstracts/DiscordInteraction";
import { Type } from "@nestjs/common";
import MiniSearch from "minisearch";

let client: Client;

@Injectable()
export class DiscordBotService {
  public client: Client;
  private discordConfig: DiscordConfig;

  private mapChoices: Record<
    e_match_types_enum,
    {
      search: MiniSearch;
      maps: { name: string; id: string }[];
    }
  > = {
    Competitive: undefined,
    Wingman: undefined,
  };

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
      .on(Events.ClientReady, () => {
        this.logger.log(`logged in as ${this.client.user.tag}!`);
      })
      .on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isAutocomplete()) {
          const autocompleteInteraction =
            interaction as AutocompleteInteraction;

          const { name, value: query } =
            autocompleteInteraction.options.getFocused(true);

          switch (name) {
            case "map":
              const matchType = (autocompleteInteraction.commandName
                .charAt(0)
                .toUpperCase() +
                autocompleteInteraction.commandName.slice(
                  1,
                )) as e_match_types_enum;
              const { maps, search } = await this.getMapChoices(matchType);

              let mapChoices = maps;
              if (query) {
                // @ts-ignore
                mapChoices = await search.search(query);
              }

              await autocompleteInteraction.respond(
                mapChoices
                  .map((map) => {
                    return {
                      name: map.name,
                      value: map.id,
                    };
                  })
                  .slice(0, 25),
              );

              break;
          }

          return;
        }

        if (interaction.isChatInputCommand()) {
          const DiscordInteraction =
            interactions.chat[
              interaction.commandName as keyof typeof interactions.chat
            ];

          const discordInteraction =
            await this.moduleRef.create<DiscordInteraction>(
              DiscordInteraction as unknown as Type<DiscordInteraction>,
            );

          return await discordInteraction.handler(interaction);
        }

        if (interaction.isButton()) {
          if (interaction.customId === "confirm_map_pool") {
            return;
          }

          const [type] = interaction.customId.split(":");
          const DiscordInteraction =
            interactions.buttons[type as keyof typeof interactions.buttons];

          const discordInteraction =
            await this.moduleRef.create<DiscordInteraction>(
              DiscordInteraction as unknown as Type<DiscordInteraction>,
            );

          return await discordInteraction.handler(interaction);
        }
      })
      .on(Events.Error, (error) => {
        console.info(error);
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
          new SlashCommandBuilder()
            .setName(ChatCommands.LinkDiscord)
            .setDescription(
              "Link your Discord account to 5stack.gg for stat tracking",
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
    return builder
      .addChannelOption((option) =>
        option
          .setName("team-selection")
          .setDescription(
            "This channel should have at least 10 or 4 people to start a match based on the type.",
          )
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
          .setDescription("Map Selection")
          .setAutocomplete(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("custom-map-pool")
          .setDescription("Allows yout to setup a custom map pool"),
      )
      .addBooleanOption((option) =>
        option
          .setName("captains")
          .setDescription(
            "Captain Picks Player Lineups, otherwise will be random lineups (default: false)",
          ),
      )
      .addUserOption((option) =>
        option.setName("captain-1").setDescription("Captain #1"),
      )
      .addUserOption((option) =>
        option.setName("captain-2").setDescription("Captain #2"),
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

  private async getMapChoices(type: e_match_types_enum) {
    if (this.mapChoices[type]) {
      return this.mapChoices[type];
    }

    const { maps } = await this.hasura.query({
      maps: {
        __args: {
          limit: 25,
          where: {
            type: {
              _eq: type,
            },
          },
        },
        id: true,
        name: true,
      },
    });

    const miniSearch = new MiniSearch({
      fields: ["name"],
      storeFields: ["name"],
      searchOptions: {
        fuzzy: 0.2,
        prefix: true,
      },
    });

    miniSearch.addAll(
      maps.map((map) => {
        return {
          id: map.id,
          name: map.name,
        };
      }),
    );

    return (this.mapChoices[type] = {
      maps,
      search: miniSearch,
    });
  }
}
