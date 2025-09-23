export interface NetworkStat {
  [key: string]: {
    tx: number;
    rx: number;
  };
}
