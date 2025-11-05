export type RegionSignalData = {
  region: string;
  peerId: string;
  signal: RTCSessionDescriptionInit;
};

export type PeerSignalData = {
  peerId: string;
  clientId: string;
  signal: RTCSessionDescriptionInit;
};
