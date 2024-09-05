import { ButtonActions } from "../enums/ButtonActions";
import { ChatCommands } from "../enums/ChatCommands";
import DiscordInteraction from "./abstracts/DiscordInteraction";

export const interactions: {
  chat: Partial<Record<ChatCommands, DiscordInteraction>>;
  buttons: Partial<Record<ButtonActions, DiscordInteraction>>;
} = {
  chat: {},
  buttons: {},
};

export function BotButtonInteraction(action: ButtonActions): ClassDecorator {
  return function (target) {
    interactions.buttons[action] = target as unknown as DiscordInteraction;
  };
}

export function BotChatCommand(action: ChatCommands): ClassDecorator {
  return function (target) {
    interactions.chat[action] = target as unknown as DiscordInteraction;
  };
}
