import MatchMapStatusEvent from "./MatchMapStatusEvent";
import MatchMapResetRoundEvent from "./MatchMapResetRoundEvent";
import MatchUpdatedLineupsEvent from "./MatchUpdatedLineupsEvent";
import PlayerConnected from "./PlayerConnected";
import PlayerDisconnected from "./PlayerDisconnected";
import CaptainEvent from "./CaptainEvent";
import KnifeSwitch from "./KnifeSwitch";
import ScoreEvent from "./ScoreEvent";
import TechTimeout from "./TechTimeout";
import KillEvent from "./KillEvent";
import DamageEvent from "./DamageEvent";
import AssistEvent from "./AssistEvent";
import UtilityEvent from "./UtilityEvent";
import FlashEvent from "./FlashEvent";
import ObjectiveEvent from "./ObjectiveEvent";
import UnusedUtility from "./UnusedUtility";
import ChatMessageEvent from "./ChatMessageEvent";
import MatchSurrendered from "./MatchSurrendered";
import MatchAbandoned from "./MatchAbandoned";

export const MatchEvents = {
  mapStatus: MatchMapStatusEvent,
  restoreRound: MatchMapResetRoundEvent,

  updateLineups: MatchUpdatedLineupsEvent,

  chat: ChatMessageEvent,

  /**
   * Player
   */
  ["player-connected"]: PlayerConnected,
  ["player-disconnected"]: PlayerDisconnected,
  captain: CaptainEvent,
  abandoned: MatchAbandoned,

  /** Match Events */
  switch: KnifeSwitch,
  score: ScoreEvent,
  surrender: MatchSurrendered,

  /**
   * Timeouts
   */
  techTimeout: TechTimeout,

  /**
   * Stats
   */
  kill: KillEvent,
  damage: DamageEvent,
  assist: AssistEvent,
  utility: UtilityEvent,
  flash: FlashEvent,
  objective: ObjectiveEvent,
  unusedUtility: UnusedUtility,
};
