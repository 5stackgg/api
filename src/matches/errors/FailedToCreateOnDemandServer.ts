export class FailedToCreateOnDemandServer extends Error {
  constructor(message = "Failed to create on demand server") {
    super(message);
  }
}
