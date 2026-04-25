import type { QuotaIncidentsSummary } from "../api/costs";
import { Identity } from "./Identity";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { relativeTime } from "@/lib/utils";

interface QuotaIncidentsPanelProps {
  incidents: QuotaIncidentsSummary | undefined;
}

// PMSA-23 / PMSA-11 §4.2: surface the agent-level incident breakdown
// (claude_quota_exhausted / claude_rate_limited / claude_provider_5xx)
// the watcher already computes server-side. Hidden when the window is empty
// so the providers tab stays quiet during normal operation.
export function QuotaIncidentsPanel({ incidents }: QuotaIncidentsPanelProps) {
  if (!incidents || incidents.byAgent.length === 0) return null;

  const { totalByCode, windowMinutes, byAgent } = incidents;
  const total401 = totalByCode.claude_quota_exhausted;
  const total429 = totalByCode.claude_rate_limited;
  const total5xx = totalByCode.claude_provider_5xx;

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">
              Quota incidents
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {`Failed Claude runs grouped by agent over the last ${windowMinutes}m.`}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-baseline gap-2 text-xs tabular-nums">
            <span className="font-medium text-red-400">{total401} 401</span>
            <span className="text-border">/</span>
            <span className="font-medium text-yellow-400">{total429} 429</span>
            {total5xx > 0 ? (
              <>
                <span className="text-border">/</span>
                <span className="font-medium text-muted-foreground">
                  {total5xx} 5xx
                </span>
              </>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-3 space-y-2">
        {byAgent.map((row) => {
          const c401 = row.countByCode.claude_quota_exhausted;
          const c429 = row.countByCode.claude_rate_limited;
          const c5xx = row.countByCode.claude_provider_5xx;
          return (
            <div
              key={row.agentId}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Identity name={row.agentName ?? row.agentId} size="sm" />
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
                <span className="flex items-center gap-2">
                  {c401 > 0 ? (
                    <span className="font-medium text-red-400">
                      {c401}
                      <span className="ml-1 font-normal text-muted-foreground">
                        401
                      </span>
                    </span>
                  ) : null}
                  {c429 > 0 ? (
                    <span className="font-medium text-yellow-400">
                      {c429}
                      <span className="ml-1 font-normal text-muted-foreground">
                        429
                      </span>
                    </span>
                  ) : null}
                  {c5xx > 0 ? (
                    <span className="font-medium text-muted-foreground">
                      {c5xx}
                      <span className="ml-1 font-normal">5xx</span>
                    </span>
                  ) : null}
                </span>
                {row.lastAt ? (
                  <span
                    className="text-muted-foreground"
                    title={new Date(row.lastAt).toLocaleString()}
                  >
                    {relativeTime(row.lastAt)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
