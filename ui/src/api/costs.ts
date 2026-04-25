import type {
  CostSummary,
  CostByAgent,
  CostByProviderModel,
  CostByBiller,
  CostByAgentModel,
  CostByProject,
  CostWindowSpendRow,
  FinanceSummary,
  FinanceByBiller,
  FinanceByKind,
  FinanceEvent,
  ProviderQuotaResult,
} from "@paperclipai/shared";
import { api } from "./client";

function dateParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<CostSummary>(
      `/companies/${companyId}/costs/summary${dateParams(from, to)}`,
    ),
  byAgent: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(
      `/companies/${companyId}/costs/by-agent${dateParams(from, to)}`,
    ),
  byAgentModel: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgentModel[]>(
      `/companies/${companyId}/costs/by-agent-model${dateParams(from, to)}`,
    ),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(
      `/companies/${companyId}/costs/by-project${dateParams(from, to)}`,
    ),
  byProvider: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProviderModel[]>(
      `/companies/${companyId}/costs/by-provider${dateParams(from, to)}`,
    ),
  byBiller: (companyId: string, from?: string, to?: string) =>
    api.get<CostByBiller[]>(
      `/companies/${companyId}/costs/by-biller${dateParams(from, to)}`,
    ),
  financeSummary: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceSummary>(
      `/companies/${companyId}/costs/finance-summary${dateParams(from, to)}`,
    ),
  financeByBiller: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceByBiller[]>(
      `/companies/${companyId}/costs/finance-by-biller${dateParams(from, to)}`,
    ),
  financeByKind: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceByKind[]>(
      `/companies/${companyId}/costs/finance-by-kind${dateParams(from, to)}`,
    ),
  financeEvents: (
    companyId: string,
    from?: string,
    to?: string,
    limit: number = 100,
  ) =>
    api.get<FinanceEvent[]>(
      `/companies/${companyId}/costs/finance-events${dateParamsWithLimit(from, to, limit)}`,
    ),
  windowSpend: (companyId: string) =>
    api.get<CostWindowSpendRow[]>(`/companies/${companyId}/costs/window-spend`),
  quotaWindows: (companyId: string) =>
    api.get<QuotaWindowsResponse>(
      `/companies/${companyId}/costs/quota-windows`,
    ),
};

// PMSA-19: legacy provider windows are wrapped under `windows` so the response
// can also surface incident counts and the live Opus throttle snapshot.
export interface QuotaIncidentBreakdown {
  agentId: string;
  agentName: string | null;
  count: number;
  countByCode: {
    claude_quota_exhausted: number;
    claude_rate_limited: number;
    claude_provider_5xx: number;
  };
  lastAt: string | null;
}

export interface QuotaIncidentsSummary {
  windowMinutes: number;
  windowStart: string;
  windowEnd: string;
  total: number;
  totalByCode: {
    claude_quota_exhausted: number;
    claude_rate_limited: number;
    claude_provider_5xx: number;
  };
  oldestAt: string | null;
  newestAt: string | null;
  byAgent: QuotaIncidentBreakdown[];
}

export interface ProviderThrottleSnapshot {
  provider: "anthropic";
  modelFamily: "opus";
  capacity: number;
  inflight: number;
  waiters: number;
}

export interface OpusSaturationSnapshot {
  provider: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface QuotaWindowsResponse {
  windows: ProviderQuotaResult[];
  incidents: QuotaIncidentsSummary;
  throttle: ProviderThrottleSnapshot;
  opusSaturation: OpusSaturationSnapshot | null;
}

function dateParamsWithLimit(
  from?: string,
  to?: string,
  limit?: number,
): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
