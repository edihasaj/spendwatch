/** Sanitized account data only. Credentials never enter snapshots or reports. */
export interface OpenRouterActivityRow {
  date: string;
  model: string;
  provider: string;
  endpointId: string;
  costUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  byokCostUsd: number;
  byokRequests: number;
}

export interface OpenRouterUsageTotals {
  costUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface OpenRouterHistory {
  updatedAt: string;
  /** API backfill is limited to completed UTC days; retain older fetched rows. */
  availableFrom: string;
  availableThrough: string;
  retainedFrom?: string;
  totals: OpenRouterUsageTotals;
  days: Array<OpenRouterUsageTotals & { date: string }>;
  months: Array<OpenRouterUsageTotals & { month: string }>;
  models: Array<OpenRouterUsageTotals & { model: string }>;
  /** Provider activity has no machine identifier; never divide it across Macs. */
  machineAttribution: "unattributed";
}

export interface OpenRouterCapacity {
  balanceUsd: number;
  totalCreditsUsd: number;
  totalUsageUsd: number;
  keyUsage?: {
    label: string;
    dailyUsd: number;
    weeklyUsd: number;
    monthlyUsd: number;
    allTimeUsd: number;
    limitUsd?: number;
    remainingUsd?: number;
    reset?: string;
    expiresAt?: string;
    byokUsd?: number;
  };
  history?: OpenRouterHistory;
}

export interface OpenRouterCapacityResult {
  provider: "openrouter";
  account: string;
  usage: {
    accountEmail: string;
    loginMethod: "Pay as you go";
    primary: null;
    secondary: null;
    tertiary: null;
    updatedAt: string;
  };
  openrouter: OpenRouterCapacity;
  devices?: string[];
}
