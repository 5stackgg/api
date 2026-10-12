// A smoke as the practice plugin watched it bloom: the voxel log CS2 networks
// on the projectile, base64, with [byteLength, tick] each time the log grew, so
// the parser can tell when every cell filled. Sent to the parser's
// /smoke-voxels as is.
export type UtilitySmokeVoxelCapture = {
  log: string;
  samples: Array<[number, number]>;
  detonation: { x: number; y: number; z: number };
  tick_rate: number;
};
