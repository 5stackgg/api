import MatchMapStatusEvent from './MatchMapStatusEvent';
import MatchMapResetRoundEvent from './MatchMapResetRoundEvent';
import MatchUpdatedLineupsEvent from './MatchUpdatedLineupsEvent';
import PlayerEvent from './PlayerEvent';
import CaptainEvent from './CaptainEvent';
import KnifeSwitch from './KnifeSwitch';
import ScoreEvent from './ScoreEvent';
import TechTimeout from './TechTimeout';
import KillEvent from './KillEvent';
import DamageEvent from './DamageEvent';
import AssistEvent from './AssistEvent';
import UtilityEvent from './UtilityEvent';
import FlashEvent from './FlashEvent';
import ObjectiveEvent from './ObjectiveEvent';
import UnusedUtility from './UnusedUtility';

export const MatchEvents = {
  mapStatus: MatchMapStatusEvent,
  restoreRound: MatchMapResetRoundEvent,

  updateLineups: MatchUpdatedLineupsEvent,

  /**
   * Player
   */
  player: PlayerEvent,
  captain: CaptainEvent,

  switch: KnifeSwitch,
  score: ScoreEvent,

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
