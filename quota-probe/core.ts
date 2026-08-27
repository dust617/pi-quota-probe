import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const QUOTA_PROBE_CONFIG_VERSION = 1;
export const QUOTA_STATUS_VERSION = 1;
export const ROUTER_BUDGET_VERSION = 1;
export const QUOTA_PLAN_PREFIX = "quota-probe:";

export type ProviderId = "zhipu" | "deepseek" | "openai-codex";
export type ProviderState = "ok" | "unknown" | "disabled";

export type SurplusBoostConfig = {
  /** Inject the surplus-boost discount only while the real remaining ratio is at or above this floor. */
  minRemainingRatio: number;
  /** Shadow-price factor encoded into the boost plan (lower = stronger priority). Consumer clamps to [0.35, 2.5]. */
  targetFactor: number;
};

export type ProviderConfig = {
  enabled: boolean;
  models: string[];
  reserveRatio: number;
  /**
   * Emit the five-hour window as a budget plan (factor + hard-stop). GLM Coding Plan has a real
   * 5h cap; Codex subscriptions currently do not, so it defaults to off there. Flip it back on
   * in quota-probe.json if a real 5h limit reappears.
   */
  fiveHourEnabled: boolean;
  /** Optional "spend the surplus" policy: discount while quota is plentiful, stop near the floor. */
  surplusBoost?: SurplusBoostConfig;
};

export type DeepSeekConfig = ProviderConfig & {
  warningBalanceCny: number;
  hardStopBalanceCny: number;
};

export type QuotaProbeConfig = {
  schemaVersion: typeof QUOTA_PROBE_CONFIG_VERSION;
  ttlMs: number;
  timeoutMs: number;
  providers: {
    zhipu: ProviderConfig;
    deepseek: DeepSeekConfig;
    "openai-codex": ProviderConfig;
  };
};

export type QuotaWindow = {
  id: "five-hour" | "weekly";
  remaining: number;
  limit: number;
  remainingRatio: number;
  resetAt: string;
  durationMs: number;
};

export type ProviderStatus = {
  state: ProviderState;
  checkedAt: string;
  code?: string;
  windows?: QuotaWindow[];
  balanceCny?: number;
  available?: boolean;
  warning?: boolean;
};

export type QuotaStatusDocument = {
  schemaVersion: typeof QUOTA_STATUS_VERSION;
  generatedAt: string;
  providers: Record<ProviderId, ProviderStatus>;
  budget: { state: "ok" | "unknown"; plansWritten: number; code?: string };
};

export type RouterBudgetPlan = {
  id: string;
  source: "quota-probe";
  enabled: true;
  models: string[];
  remainingRatio?: number;
  reserveRatio?: number;
  hardStop?: boolean;
  available?: boolean;
  periodStartedAt?: string;
  periodEndsAt?: string;
  /** Frozen window progress; pi-model-auto accepts this in place of parsed timestamps. */
  periodProgress?: number;
  updatedAt: string;
};

export type RouterBudgetDocument = {
  schemaVersion: typeof ROUTER_BUDGET_VERSION;
  updatedAt: string;
  plans: Array<Record<string, unknown>>;
};

export const DEFAULT_QUOTA_PROBE_CONFIG: QuotaProbeConfig = {
  schemaVersion: QUOTA_PROBE_CONFIG_VERSION,
  ttlMs: 300_000,
  timeoutMs: 15_000,
  providers: {
    zhipu: {
      enabled: true,
      models: ["zhipu/glm-5.3", "zhipu/glm-5.3-flash"],
      reserveRatio: 0.05,
      fiveHourEnabled: true,
    },
    deepseek: {
      enabled: true,
      models: ["deepseek/deepseek-v4-flash-vision-exp"],
      reserveRatio: 0,
      fiveHourEnabled: true,
      warningBalanceCny: 5,
      hardStopBalanceCny: 2,
    },
    "openai-codex": {
      // The undocumented usage endpoint must be enabled explicitly in quota-probe.json.
      enabled: false,
      models: [
        "openai-codex/gpt-5.6-luna",
        "openai-codex/gpt-5.6-terra",
        "openai-codex/gpt-5.6-sol",
      ],
      reserveRatio: 0.05,
      // No real 5h limit on the current subscription; weight and hard-stop come from the weekly
      // window only. Re-enable if the primary wham window becomes a binding cap again.
      fiveHourEnabled: false,
      // Frequently reset windows: burn the surplus while plentiful, normal pricing by ~50% left.
      // Encoding: consumer factor = clamp(1 − 1.25·(remaining − (1−progress)), 0.35, 2.5);
      // the boost plan pins remaining=1 and encodes progress=(1−targetFactor)/1.25, reproducing
      // the exact target factor while never fighting the protective (factor > 1) direction.
      surplusBoost: { minRemainingRatio: 0.5, targetFactor: 0.7 },
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function cloneConfig(): QuotaProbeConfig {
  return JSON.parse(JSON.stringify(DEFAULT_QUOTA_PROBE_CONFIG)) as QuotaProbeConfig;
}

function validModels(value: unknown, fallback: string[]): string[] | undefined {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined;
  const models = value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200);
  return models.length === value.length ? models : undefined;
}

function ratio(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = finiteNumber(value);
  return parsed === undefined || parsed < 0 || parsed > 1 ? undefined : parsed;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = finiteNumber(value);
  return parsed === undefined || !Number.isInteger(parsed) || parsed < min || parsed > max ? undefined : parsed;
}

function applySurplusBoost(input: unknown, fallback: SurplusBoostConfig | undefined): SurplusBoostConfig | undefined {
  if (input === undefined) return fallback === undefined ? undefined : { ...fallback };
  if (!isRecord(input)) return undefined;
  const minRemainingRatio = ratio(input.minRemainingRatio, fallback?.minRemainingRatio ?? 0.5);
  const rawTarget = finiteNumber(input.targetFactor ?? fallback?.targetFactor ?? 0.7);
  if (minRemainingRatio === undefined || minRemainingRatio < 0.1 || rawTarget === undefined) return undefined;
  const targetFactor = clamp(rawTarget, 0.5, 0.95);
  return { minRemainingRatio, targetFactor };
}

function applyProviderConfig(input: unknown, fallback: ProviderConfig): ProviderConfig | undefined {
  if (input === undefined) return { ...fallback, models: [...fallback.models], surplusBoost: fallback.surplusBoost ? { ...fallback.surplusBoost } : undefined };
  if (!isRecord(input)) return undefined;
  const enabled = input.enabled === undefined ? fallback.enabled : input.enabled;
  const models = validModels(input.models, fallback.models);
  const reserveRatio = ratio(input.reserveRatio, fallback.reserveRatio);
  const fiveHourEnabled = input.fiveHourEnabled === undefined ? fallback.fiveHourEnabled : input.fiveHourEnabled;
  if (typeof enabled !== "boolean" || !models || reserveRatio === undefined || typeof fiveHourEnabled !== "boolean") return undefined;
  const surplusBoost = applySurplusBoost(input.surplusBoost, fallback.surplusBoost);
  if (input.surplusBoost !== undefined && surplusBoost === undefined) return undefined;
  return { enabled, models, reserveRatio, fiveHourEnabled, surplusBoost };
}

export function parseQuotaProbeConfig(raw: unknown): QuotaProbeConfig | undefined {
  if (raw === undefined) return cloneConfig();
  if (!isRecord(raw) || raw.schemaVersion !== QUOTA_PROBE_CONFIG_VERSION) return undefined;
  const defaults = cloneConfig();
  const ttlMs = boundedInt(raw.ttlMs, defaults.ttlMs, 30_000, 3_600_000);
  const timeoutMs = boundedInt(raw.timeoutMs, defaults.timeoutMs, 1_000, 30_000);
  if (ttlMs === undefined || timeoutMs === undefined) return undefined;

  const providers = isRecord(raw.providers) ? raw.providers : undefined;
  if (!providers) return undefined;
  const zhipu = applyProviderConfig(providers.zhipu, defaults.providers.zhipu);
  const deepseekBase = applyProviderConfig(providers.deepseek, defaults.providers.deepseek);
  const codex = applyProviderConfig(providers["openai-codex"], defaults.providers["openai-codex"]);
  if (!zhipu || !deepseekBase || !codex || !isRecord(providers.deepseek)) return undefined;

  const warningBalanceCny = finiteNumber(providers.deepseek.warningBalanceCny ?? defaults.providers.deepseek.warningBalanceCny);
  const hardStopBalanceCny = finiteNumber(providers.deepseek.hardStopBalanceCny ?? defaults.providers.deepseek.hardStopBalanceCny);
  if (
    warningBalanceCny === undefined || hardStopBalanceCny === undefined ||
    warningBalanceCny < 0 || hardStopBalanceCny < 0 ||
    warningBalanceCny > 1_000_000 || hardStopBalanceCny > warningBalanceCny
  ) {
    return undefined;
  }

  return {
    schemaVersion: QUOTA_PROBE_CONFIG_VERSION,
    ttlMs,
    timeoutMs,
    providers: {
      zhipu,
      deepseek: { ...deepseekBase, warningBalanceCny, hardStopBalanceCny },
      "openai-codex": codex,
    },
  };
}

function timestamp(value: unknown, now: number): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  if (parsed < 100_000_000_000) return Math.floor(parsed * 1_000);
  return Math.floor(parsed);
}

function toWindow(
  id: QuotaWindow["id"],
  remaining: number,
  limit: number,
  resetAtMs: number,
  durationMs: number,
): QuotaWindow | undefined {
  if (
    !Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(resetAtMs) || !Number.isFinite(durationMs) ||
    limit <= 0 || remaining < 0 || resetAtMs <= 0 || durationMs <= 0
  ) {
    return undefined;
  }
  return {
    id,
    remaining: clamp(remaining, 0, limit),
    limit,
    remainingRatio: clamp(remaining / limit, 0, 1),
    resetAt: new Date(resetAtMs).toISOString(),
    durationMs,
  };
}

type ZhipuLimit = { unit?: number; number?: number; remaining: number; limit: number; resetAtMs: number };

function parseZhipuLimit(value: unknown, now: number): ZhipuLimit | undefined {
  if (!isRecord(value)) return undefined;
  const limit = finiteNumber(value.usage);
  const current = finiteNumber(value.currentValue) ?? 0;
  const remaining = finiteNumber(value.remaining) ?? (limit === undefined ? undefined : Math.max(0, limit - current));
  const resetAtMs = timestamp(value.nextResetTime, now);
  if (limit === undefined || remaining === undefined || resetAtMs === undefined || limit <= 0 || remaining < 0) return undefined;
  return {
    unit: finiteNumber(value.unit),
    number: finiteNumber(value.number),
    remaining: clamp(remaining, 0, limit),
    limit,
    resetAtMs,
  };
}

/** Parse the Zhipu Coding Plan quota response without retaining its raw payload. */
export function parseZhipuQuota(payload: unknown, now = Date.now()): QuotaWindow[] | undefined {
  const root = isRecord(payload) ? payload : undefined;
  const data = root && isRecord(root.data) ? root.data : undefined;
  const values = data && Array.isArray(data.limits) ? data.limits : undefined;
  if (!values) return undefined;
  const limits = values.map((item) => parseZhipuLimit(item, now)).filter((item): item is ZhipuLimit => Boolean(item));
  if (limits.length === 0) return undefined;

  const short = limits.find((item) => item.unit === 3 || item.number === 5)
    ?? limits.find((item) => item.resetAtMs > now && item.resetAtMs - now <= 6 * 60 * 60 * 1_000);
  const weekly = limits.find((item) => item !== short && (item.unit === 6 || item.number === 1))
    ?? limits.find((item) => item !== short && item.resetAtMs > now && item.resetAtMs - now <= 8 * 24 * 60 * 60 * 1_000);

  const windows = [
    short && toWindow("five-hour", short.remaining, short.limit, short.resetAtMs, 5 * 60 * 60 * 1_000),
    weekly && toWindow("weekly", weekly.remaining, weekly.limit, weekly.resetAtMs, 7 * 24 * 60 * 60 * 1_000),
  ].filter((item): item is QuotaWindow => Boolean(item));
  return windows.length > 0 ? windows : undefined;
}

export type DeepSeekBalance = { available: boolean; balanceCny: number };

/** Parse DeepSeek's /user/balance result and aggregate only the CNY balance. */
export function parseDeepSeekBalance(payload: unknown): DeepSeekBalance | undefined {
  if (!isRecord(payload) || typeof payload.is_available !== "boolean" || !Array.isArray(payload.balance_infos)) return undefined;
  let balanceCny = 0;
  let foundCny = false;
  for (const entry of payload.balance_infos) {
    if (!isRecord(entry) || entry.currency !== "CNY") continue;
    const total = finiteNumber(entry.total_balance);
    if (total === undefined || total < 0) return undefined;
    balanceCny += total;
    foundCny = true;
  }
  return foundCny ? { available: payload.is_available, balanceCny } : undefined;
}

function codexWindow(value: unknown, id: QuotaWindow["id"], fallbackDurationMs: number, now: number): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  const used = finiteNumber(value.used_percent ?? value.usedPercent ?? value.percent_used);
  if (used === undefined || used < 0 || used > 100) return undefined;
  const resetAtMs = timestamp(value.reset_at ?? value.resetAt, now)
    ?? (() => {
      const after = finiteNumber(value.reset_after_seconds ?? value.resetAfterSeconds);
      return after === undefined || after < 0 ? undefined : now + after * 1_000;
    })();
  const seconds = finiteNumber(value.limit_window_seconds ?? value.limitWindowSeconds);
  const durationMs = seconds !== undefined && seconds > 0 ? seconds * 1_000 : fallbackDurationMs;
  return resetAtMs === undefined ? undefined : toWindow(id, 100 - used, 100, resetAtMs, durationMs);
}

/** Parse the undocumented Codex usage shape defensively; unknown shapes produce no budget. */
export function parseCodexUsage(payload: unknown, now = Date.now()): QuotaWindow[] | undefined {
  if (!isRecord(payload)) return undefined;
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit
    : isRecord(payload.rateLimit) ? payload.rateLimit
      : payload;
  const windows = [
    codexWindow(rateLimit.primary_window ?? rateLimit.primaryWindow, "five-hour", 5 * 60 * 60 * 1_000, now),
    codexWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow, "weekly", 7 * 24 * 60 * 60 * 1_000, now),
  ].filter((item): item is QuotaWindow => Boolean(item));
  return windows.length > 0 ? windows : undefined;
}

/** Extract the account id Pi itself uses for Codex requests. Never persist or display the result. */
export function extractCodexAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = isRecord(payload["https://api.openai.com/auth"])
      ? payload["https://api.openai.com/auth"]
      : undefined;
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 && accountId.length <= 200 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function planFromWindow(prefix: string, window: QuotaWindow, models: string[], reserveRatio: number, now: number): RouterBudgetPlan | undefined {
  const end = Date.parse(window.resetAt);
  if (!Number.isFinite(end) || end <= now) return undefined;
  const start = end - window.durationMs;
  return {
    id: `${QUOTA_PLAN_PREFIX}${prefix}-${window.id}`,
    source: "quota-probe",
    enabled: true,
    models: [...models],
    remainingRatio: window.remainingRatio,
    reserveRatio,
    hardStop: true,
    periodStartedAt: new Date(start).toISOString(),
    periodEndsAt: new Date(end).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

/** Convert only successful provider observations into safe router-budget plan entries. */
export function buildQuotaBudgetPlans(
  config: QuotaProbeConfig,
  providers: Record<ProviderId, ProviderStatus>,
  now = Date.now(),
): RouterBudgetPlan[] {
  const plans: RouterBudgetPlan[] = [];
  const appendWindows = (prefix: string, status: ProviderStatus, cfg: ProviderConfig) => {
    if (status.state !== "ok" || !status.windows) return;
    for (const window of status.windows) {
      if (window.id === "five-hour" && !cfg.fiveHourEnabled) continue;
      const plan = planFromWindow(prefix, window, cfg.models, cfg.reserveRatio, now);
      if (plan) plans.push(plan);
      const boost = plan && surplusBoostPlan(prefix, plan, window, cfg, now);
      if (boost) plans.push(boost);
    }
  };
  appendWindows("zhipu", providers.zhipu, config.providers.zhipu);
  appendWindows("codex", providers["openai-codex"], config.providers["openai-codex"]);

  const deepseek = providers.deepseek;
  if (
    config.providers.deepseek.enabled &&
    deepseek.state === "ok" &&
    (deepseek.available === false || (deepseek.balanceCny !== undefined && deepseek.balanceCny <= config.providers.deepseek.hardStopBalanceCny))
  ) {
    plans.push({
      id: `${QUOTA_PLAN_PREFIX}deepseek-balance`,
      source: "quota-probe",
      enabled: true,
      models: [...config.providers.deepseek.models],
      available: false,
      updatedAt: new Date(now).toISOString(),
    });
  }
  return plans;
}

/**
 * While quota is plentiful AND the natural plan is not protective (natural factor ≤ 1), inject a
 * synthetic plan that pins the effective shadow-cost factor at exactly `surplusBoost.targetFactor`,
 * pushing Auto to spend down subscription surplus before it expires. Below `minRemainingRatio`
 * (or whenever the model is burning faster than its window schedule), no boost plan is emitted and
 * the natural plan alone drives pricing back to neutral/protective.
 */
function surplusBoostPlan(
  prefix: string,
  natural: RouterBudgetPlan,
  window: QuotaWindow,
  cfg: ProviderConfig,
  now: number,
): RouterBudgetPlan | undefined {
  const boost = cfg.surplusBoost;
  if (!boost) return undefined;
  // The spend-down boost is a fast-resetting-window concept; it must never force a weekly discount.
  if (window.id !== "five-hour") return undefined;
  if (window.remainingRatio < boost.minRemainingRatio) return undefined;
  const start = Date.parse(natural.periodStartedAt ?? "");
  const end = Date.parse(natural.periodEndsAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const progress = Math.max(0, Math.min(1, (now - start) / (end - start)));
  const delta = window.remainingRatio - (1 - progress);
  const naturalFactor = Math.max(0.35, Math.min(2.5, 1 - 1.25 * delta));
  if (naturalFactor > 1) return undefined;
  // Consumer: factor = clamp(1 − 1.25·(remaining − (1−progress)), 0.35, 2.5). To reproduce the
  // exact target factor with a pinned window, set remaining=1 and encode the progress that yields
  // it: targetFactor = 1 − 1.25·progress ⇒ progress = (1 − targetFactor) / 1.25 (0.24 for 0.70).
  const encodedProgress = (1 - boost.targetFactor) / 1.25;
  return {
    id: `${QUOTA_PLAN_PREFIX}${prefix}-${window.id}-surplus-boost`,
    source: "quota-probe",
    enabled: true,
    models: [...cfg.models],
    remainingRatio: 1,
    periodProgress: encodedProgress,
    hardStop: false,
    updatedAt: new Date(now).toISOString(),
  };
}

/** Preserve user-authored budget plans while replacing only quota-probe-owned plans. */
export function mergeRouterBudget(
  current: unknown,
  probePlans: RouterBudgetPlan[],
  now = Date.now(),
): RouterBudgetDocument | undefined {
  let preserved: Array<Record<string, unknown>> = [];
  if (current !== undefined) {
    if (!isRecord(current) || current.schemaVersion !== ROUTER_BUDGET_VERSION || !Array.isArray(current.plans)) return undefined;
    if (!current.plans.every(isRecord)) return undefined;
    preserved = current.plans.filter((plan) => typeof plan.id !== "string" || !plan.id.startsWith(QUOTA_PLAN_PREFIX));
  }
  return {
    schemaVersion: ROUTER_BUDGET_VERSION,
    updatedAt: new Date(now).toISOString(),
    plans: [...preserved, ...probePlans],
  };
}

export function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error: unknown) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomic local write; all persisted fields are already normalized and credential-free. */
export function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

function percent(window: QuotaWindow): string {
  return `${Math.round(window.remainingRatio * 100)}%`;
}

/** Human-friendly, credential-free status lines for the Pi UI. */
export function formatQuotaStatus(status: QuotaStatusDocument): string {
  const lines = [`Quota refreshed: ${status.generatedAt}`];
  const describeWindows = (label: string, provider: ProviderStatus) => {
    if (provider.state === "disabled") return `${label}: disabled`;
    if (provider.state !== "ok" || !provider.windows?.length) return `${label}: unknown${provider.code ? ` (${provider.code})` : ""}`;
    const values = provider.windows.map((window) => `${window.id === "five-hour" ? "5h" : "week"} ${percent(window)}`).join(", ");
    return `${label}: ${values}`;
  };
  lines.push(describeWindows("GLM", status.providers.zhipu));
  const deepseek = status.providers.deepseek;
  if (deepseek.state === "disabled") lines.push("DeepSeek: disabled");
  else if (deepseek.state !== "ok" || deepseek.balanceCny === undefined) lines.push(`DeepSeek: unknown${deepseek.code ? ` (${deepseek.code})` : ""}`);
  else lines.push(`DeepSeek: ¥${deepseek.balanceCny.toFixed(2)}${deepseek.warning ? " (low)" : ""}`);
  lines.push(describeWindows("Codex", status.providers["openai-codex"]));
  lines.push(`Router budget: ${status.budget.state === "ok" ? `${status.budget.plansWritten} probe plan(s)` : `unchanged (${status.budget.code ?? "unknown"})`}`);
  return lines.join("\n");
}
