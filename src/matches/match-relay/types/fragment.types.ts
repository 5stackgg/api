export type FragmentField = "start" | "full" | "delta";

// What the game server sent in the query string alongside a field's body, plus
// what the relay records about it. Numeric protocol fields are stored as
// numbers so /sync can return them as JSON numbers.
export type FieldMeta = {
  gipped?: boolean;
  timestamp?: number;
  signup_fragment?: number;
  tick?: number;
  endtick?: number;
  tps?: number;
  map?: string;
  keyframe_interval?: number;
  protocol?: number;
  [key: string]: unknown;
};
