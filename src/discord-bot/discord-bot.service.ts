import { LazyModuleLoader, ModuleRef } from "@nestjs/core";
import { Injectable } from "@nestjs/common";
import {
  ButtonInteraction,
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { e_match_types_enum } from "../../generated/zeus";
import { ChatCommands } from "./enums/ChatCommands";
import { ButtonActions } from "./enums/ButtonActions";
import { HasuraService } from "../hasura/hasura.service";

const _interactions: {
  chat: Partial<
    Record<
      ChatCommands,
      {
        target: any;
        action: string;
        resolved?: any;
      }
    >
  >;
  buttons: Partial<
    Record<
      ButtonActions,
      {
        target: any;
        action: string;
        resolved?: any;
      }
    >
  >;
} = {
  chat: {},
  buttons: {},
};

export function BotButtonInteraction(action: ButtonActions) {
  return function (target: any) {
    _interactions.buttons[action] = {
      target,
      action,
    };
  };
}

export function BotChatCommand(action: ChatCommands) {
  return function (target: any) {
    _interactions.chat[action] = {
      target,
      action,
    };
  };
}

// TODO - this service loads twice because of the lazy loading
let client;

@Injectable()
export class DiscordBotService {
  public client: Client;

  constructor(
    private readonly hasura: HasuraService,
    private readonly lazyModuleLoader: LazyModuleLoader
  ) {
    this.client = client;
  }

  public async login() {
    client = this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    const { DiscordBotInteractionModule } = await import(
      "./interactions/discord-bot-interaction.module"
    );
    const moduleRef = await this.lazyModuleLoader.load(
      () => DiscordBotInteractionModule
    );

    this.client
      .on("ready", () => {
        console.info(`logged in as ${this.client.user.tag}!`);
      })
      .on("interactionCreate", async (interaction) => {
        if (interaction.isChatInputCommand()) {
          console.info(
            `[${interaction.commandName}]`,
            _interactions.chat[interaction.commandName]
          );
          return await moduleRef
            .get(_interactions.chat[interaction.commandName].target)
            .handler(interaction);
        }

        if (interaction.isButton()) {
          const [type] = (interaction as ButtonInteraction).customId.split(":");
          return await moduleRef
            .get(_interactions.buttons[type].target)
            .handler(interaction);
        }
      })
      .on("error", (error) => {
        console.warn("unhandled error", error);
      });

    await this.client.login(process.env.DISCORD_TOKEN);
  }

  private async setupBot() {
    const rest = new REST({ version: "10" }).setToken(
      process.env.DISCORD_TOKEN
    );

    try {
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
        {
          body: [
            await this.addBaseOptions(
              new SlashCommandBuilder()
                .setName(ChatCommands.ScheduleComp)
                .setDescription("Creates a Competitive Match")
            ),
            await this.addBaseOptions(
              new SlashCommandBuilder()
                .setName(ChatCommands.ScheduleScrimmage)
                .setDescription("Creates a Scrimmage")
            ),
            await this.addBaseOptions(
              new SlashCommandBuilder()
                .setName(ChatCommands.ScheduleWingMan)
                .setDescription("Creates a Wingman Match")
            ),
          ],
        }
      );

      console.info("successfully reloaded application (/) interactions.");
    } catch (error) {
      console.error(`unable to reload application (/) commands`, error);
    }
  }

  private async addBaseOptions(builder: SlashCommandBuilder) {
    const mapChoices = await this.getMapChoices(e_match_types_enum.Competitive);

    return builder
      .addChannelOption((option) =>
        option
          .setName("team-selection")
          .setDescription(
            "This channel should have at least 10 or 4 people to start a match based on the type."
          )
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice)
      )
      .addBooleanOption((option) =>
        option
          .setName("knife")
          .setDescription("Knife Round to pick sides (default: true)")
      )
      .addBooleanOption((option) =>
        option
          .setName("overtime")
          .setDescription("Allow Overtime (default: true)")
      )
      .addStringOption((option) =>
        option
          .setName("map")
          .setDescription("override map")
          .addChoices(...mapChoices)
      )
      .addBooleanOption((option) =>
        option
          .setName("captains")
          .setDescription("Captain Picks (default: true)")
      )
      .addUserOption((option) =>
        option.setName("captain-1").setDescription("Captain #1")
      )
      .addUserOption((option) =>
        option.setName("captain-2").setDescription("Captain #2")
      )
      .addBooleanOption((option) =>
        option
          .setName("on-demand-server")
          .setDescription(
            "Use On Demand Server. If disabled, it will ask to use one of your servers (default: true)"
          )
      )
      .addStringOption((option) =>
        option
          .setName("mr")
          .setDescription("Sets the number of rounds per half (default MR12)")
          .addChoices(
            { name: "MR3", value: "3" },
            { name: "MR8", value: "8" },
            { name: "MR12", value: "12" },
            { name: "MR15", value: "15" }
          )
      );
  }

  private async getMapChoices(type: e_match_types_enum) {
    const { map_pools } = await this.hasura.query({
      map_pools: [
        {},
        {
          label: true,
          maps: [
            {},
            {
              id: true,
              name: true,
            },
          ],
        },
      ],
    });

    const map_pool = map_pools.find(({ label }) => {
      return label === type;
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
