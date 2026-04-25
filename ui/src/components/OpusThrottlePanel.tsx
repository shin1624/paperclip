import type {
  OpusSaturationSnapshot,
  ProviderThrottleSnapshot,
} from "../api/costs";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn, providerDisplayName, relativeTime } from "@/lib/utils";

interface OpusThrottlePanelProps {
  throttle: ProviderThrottleSnapshot | undefined;
  opusSaturation: OpusSaturationSnapshot | null | undefined;
}

// PMSA-23 / PMSA-11 §4.2: render the live company-wide Opus semaphore
// snapshot (PMSA-16) plus the weekly Opus subscription saturation the
// quota watcher (PMSA-19) uses for board notifications. Always shown on the
// providers tab so the operator sees throttle state even when no incidents
// are firing yet.
export function OpusThrottlePanel({
  throttle,
  opusSaturation,
}: OpusThrottlePanelProps) {
  if (!throttle) return null;

  const { capacity, inflight, waiters, provider, modelFamily } = throttle;
  const utilizationPct =
    capacity <= 0 ? 0 : Math.min(100, Math.max(0, (inflight / capacity) * 100));

  const inflightFill =
    inflight >= capacity
      ? "bg-red-400"
      : inflight >= Math.ceil(capacity * 0.7)
        ? "bg-yellow-400"
        : "bg-green-400";

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">
              {providerDisplayName(provider)} {modelFamily} throttle
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Live company-wide concurrency limit and weekly subscription
              saturation.
            </CardDescription>
          </div>
          <SaturationBadge saturation={opusSaturation ?? null} />
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-3 space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">In flight</span>
            <span className="tabular-nums">
              <span className="font-medium">{inflight}</span>
              <span className="ml-1 text-muted-foreground">
                / {capacity} slots
              </span>
            </span>
          </div>
          <div className="h-2 w-full border border-border overflow-hidden">
            <div
              className={cn(
                "h-full transition-[width,background-color] duration-150",
                inflightFill,
              )}
              style={{ width: `${utilizationPct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Waiters</span>
          <span className="tabular-nums">
            <span
              className={cn(
                "font-medium",
                waiters > 0 ? "text-yellow-400" : "text-foreground",
              )}
            >
              {waiters}
            </span>
            <span className="ml-1 text-muted-foreground">
              {waiters === 1 ? "run queued" : "runs queued"}
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function SaturationBadge({
  saturation,
}: {
  saturation: OpusSaturationSnapshot | null;
}) {
  if (!saturation) return null;
  const pct = saturation.usedPercent;
  const variant: "secondary" | "destructive" =
    pct >= 100 ? "destructive" : "secondary";
  // amber-tinted secondary so 90-99% reads as warning without overlapping
  // the destructive shade reserved for >= 100%.
  const className =
    pct >= 100
      ? ""
      : pct >= 90
        ? "bg-yellow-400/20 text-yellow-100 border-yellow-400/40"
        : "";
  return (
    <Badge
      variant={variant}
      className={cn("shrink-0 tabular-nums", className)}
      title={
        saturation.resetsAt
          ? `${saturation.label}: resets ${relativeTime(saturation.resetsAt)}`
          : saturation.label
      }
    >
      {saturation.label} · {pct}%
    </Badge>
  );
}
