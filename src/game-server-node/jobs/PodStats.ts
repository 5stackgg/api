import { PodMetric } from "@kubernetes/client-node";

export class PodStats {
  name?: string;
  metrics: PodMetric;
}
