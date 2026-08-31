import { BadRequestException } from "@nestjs/common";
import { FileManagerService } from "./file-manager.service";

// Nest builds an HttpException's message from the response only when it is a
// string; anything else falls back to the class name, so the operator is told
// "Bad Request Exception" and nothing about what they did wrong.
describe("FileManagerService.connectorErrorMessage", () => {
  const message = (error: unknown) =>
    new BadRequestException(FileManagerService.connectorErrorMessage(error))
      .message;

  it("flattens the array the connector's ValidationPipe returns", () => {
    expect(
      FileManagerService.connectorErrorMessage({
        statusCode: 400,
        message: [
          "destPath must be a string",
          "sourcePath should not be empty",
        ],
        error: "Bad Request",
      }),
    ).toBe("destPath must be a string, sourcePath should not be empty");
  });

  it("passes a plain string through", () => {
    expect(
      FileManagerService.connectorErrorMessage({
        message: "Destination already exists: addons",
      }),
    ).toBe("Destination already exists: addons");
  });

  // A proxy in front of the connector answers in its own shape, and an object
  // reaching BadRequestException reads as "Bad Request Exception".
  it("flattens a message that is not a string at all", () => {
    expect(message({ message: { error: "path traversal detected" } })).toBe(
      '{"error":"path traversal detected"}',
    );
    expect(message({ message: 400 })).toBe("400");
  });

  it("gives an empty string when there is no message to report", () => {
    expect(FileManagerService.connectorErrorMessage({})).toBe("");
    expect(FileManagerService.connectorErrorMessage(undefined)).toBe("");
    expect(FileManagerService.connectorErrorMessage({ message: null })).toBe(
      "",
    );
  });

  it("survives the round trip into an exception the operator reads", () => {
    expect(message({ message: ["destPath must be a string"] })).toBe(
      "destPath must be a string",
    );
  });
});
