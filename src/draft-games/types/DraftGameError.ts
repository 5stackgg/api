export class DraftGameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftGameError";
  }
}
