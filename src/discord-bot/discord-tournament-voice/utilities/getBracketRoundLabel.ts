export function getBracketRoundLabel(
  roundNumber: number,
  stage: number,
  isFinalStage: boolean,
  totalMatchesInRound: number,
  isLoserBracket: boolean,
  stageType: string | null | undefined,
  isLastRound: boolean,
): string {
  if (stageType === "RoundRobin" || stageType === "Swiss") {
    return `Round ${roundNumber}`;
  }

  const isDE = stageType === "DoubleElimination";

  if (isLoserBracket) {
    if (isLastRound) {
      return "LB Final";
    }
    return `LB Round ${roundNumber}`;
  }

  if (stage === 1 && roundNumber === 1) {
    return isDE ? "WB Opening Round" : "Opening Round";
  }

  if (isFinalStage) {
    if (totalMatchesInRound === 4) {
      return isDE ? "WB Quarter-Finals" : "Quarter-Finals";
    }

    if (totalMatchesInRound === 2) {
      if (isLastRound && stageType === "SingleElimination") {
        return "Final";
      }
      return isDE ? "WB Semi-Finals" : "Semi-Finals";
    }

    if (totalMatchesInRound === 1) {
      if (isDE && !isLastRound) {
        return "WB Final";
      }
      return isDE ? "Grand Final" : "Final";
    }
  }

  return isDE ? `WB Round ${roundNumber}` : `Round ${roundNumber}`;
}
