// Echoed on `chat:ack` and `chat:error` so the client knows which request the
// answer is for. A contract with the web -- add to it, never rename.
export type ChatAction = "send" | "delete" | "edit";
