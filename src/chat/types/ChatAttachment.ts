export type ChatAttachmentKind = "image" | "video";

// What a message carries for each file. The file itself is served by id from
// /chat/attachments, behind the same access check as its room.
export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  poster?: boolean;
}
