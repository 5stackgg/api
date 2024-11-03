import { SinglePodMetrics } from "@kubernetes/client-node";

export class PodStats {
    name?: string;
    metrics: SinglePodMetrics;
}