export type StartFieldData = {
  data?: Buffer;
  gipped?: boolean;
  signup_fragment?: number;
  tick?: number;
  tps?: number;
  map?: string;
  keyframe_interval?: number;
  protocol?: number;
  [key: string]: any;
};

export type FullFieldData = {
  data?: Buffer;
  gipped?: boolean;
  tick?: number;
  [key: string]: any;
};

export type DeltaFieldData = {
  data?: Buffer;
  gipped?: boolean;
  timestamp?: number;
  endtick?: number;
  [key: string]: any;
};

export type Fragment = {
  start?: StartFieldData;
  full?: FullFieldData;
  delta?: DeltaFieldData;
  [key: string]: any;
};

export type Broadcast = Fragment[];

