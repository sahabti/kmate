import type { Tone } from "@/components/tone";
import { ClusterStatus } from "@/gen/kmate/v1/hub_pb";

interface ClusterStatusDisplay {
  tone: Tone;
  label: string;
}

export const statusTone = (s: ClusterStatus): ClusterStatusDisplay => {
  switch (s) {
    case ClusterStatus.ONLINE:
      return { tone: "ok", label: "Online" };
    case ClusterStatus.OFFLINE:
      return { tone: "bad", label: "Offline" };
    case ClusterStatus.PENDING:
      return { tone: "warn", label: "Pending" };
    default:
      return { tone: "muted", label: "Unknown" };
  }
};
