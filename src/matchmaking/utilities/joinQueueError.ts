export class JoinQueueError extends Error {
  constructor(
    message: string,
    public readonly lobbyId?: string,
  ) {
    super(message);
    this.name = "JoinQueueError";
    this.lobbyId = lobbyId || "";
  }

  public getLobbyId() {
    return this.lobbyId;
  }
}
