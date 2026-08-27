import { join } from "node:path";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildQuotaBudgetPlans,
  extractCodexAccountId,
  formatQuotaStatus,
  parseCodexUsage,
  parseDeepSeekBalance,
  parseQuotaProbeConfig,
  parseZhipuQuota,
  readJsonFile,
  type ProviderConfig,
  type ProviderId,
  type ProviderStatus,
  type QuotaProbeConfig,
  type QuotaStatusDocument,
  writeJsonAtomically,
  mergeRouterBudget,
  QUOTA_STATUS_VERSION,
} from "./core.js";

const ZHIPU_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
// This is a ChatGPT internal endpoint. It is intentionally kept behind the explicit
// project config flag and never becomes a hard failure when it changes or rejects a request.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// While any enabled provider is hard-stopped/exhausted, re-probe this often so a recovered
// window un-blocks the models quickly (Codex quota resets frequently). Once healthy, the
// normal TTL applies again.
const EXHAUSTED_RETRY_MS = 60_000;

type RefreshResult = {
  status: QuotaStatusDocument;
  config?: QuotaProbeConfig;
};

function paths(ctx: ExtensionContext) {
  const root = join(ctx.cwd, CONFIG_DIR_NAME);
  return {
    config: join(root, "quota-probe.json"),
    status: join(root, "quota-status.json"),
    budget: join(root, "router-budget.json"),
  };
}

function unknown(checkedAt: string, code: string): ProviderStatus {
  return { state: "unknown", checkedAt, code };
}

function disabled(checkedAt: string): ProviderStatus {
  return { state: "disabled", checkedAt };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /abort|timeout/i.test(error.name)) return "timeout";
  return "request-failed";
}

async function requestJson(url: string, apiKey: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<
  { ok: true; value: unknown } | { ok: false; code: string }
> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, code: `http-${response.status}` };
    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: false, code: "invalid-json" };
    }
  } catch (error) {
    return { ok: false, code: safeFailureCode(error) };
  }
}

async function apiKeyFor(ctx: ExtensionContext, provider: ProviderId, models: string[]): Promise<string | undefined> {
  for (const ref of models) {
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) continue;
    const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (!model) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && typeof auth.apiKey === "string" && auth.apiKey.length > 0) return auth.apiKey;
  }
  return undefined;
}

async function refreshZhipu(ctx: ExtensionContext, config: ProviderConfig, timeoutMs: number, now: number): Promise<ProviderStatus> {
  const checkedAt = new Date(now).toISOString();
  if (!config.enabled) return disabled(checkedAt);
  const apiKey = await apiKeyFor(ctx, "zhipu", config.models);
  if (!apiKey) return unknown(checkedAt, "auth-unavailable");
  const response = await requestJson(ZHIPU_QUOTA_URL, apiKey, timeoutMs);
  if (!response.ok) return unknown(checkedAt, response.code);
  const windows = parseZhipuQuota(response.value, now);
  return windows ? { state: "ok", checkedAt, windows } : unknown(checkedAt, "invalid-response");
}

async function refreshDeepSeek(ctx: ExtensionContext, config: QuotaProbeConfig["providers"]["deepseek"], timeoutMs: number, now: number): Promise<ProviderStatus> {
  const checkedAt = new Date(now).toISOString();
  if (!config.enabled) return disabled(checkedAt);
  const apiKey = await apiKeyFor(ctx, "deepseek", config.models);
  if (!apiKey) return unknown(checkedAt, "auth-unavailable");
  const response = await requestJson(DEEPSEEK_BALANCE_URL, apiKey, timeoutMs);
  if (!response.ok) return unknown(checkedAt, response.code);
  const balance = parseDeepSeekBalance(response.value);
  if (!balance) return unknown(checkedAt, "invalid-response");
  return {
    state: "ok",
    checkedAt,
    available: balance.available,
    balanceCny: balance.balanceCny,
    warning: !balance.available || balance.balanceCny <= config.warningBalanceCny,
  };
}

async function refreshCodex(ctx: ExtensionContext, config: ProviderConfig, timeoutMs: number, now: number): Promise<ProviderStatus> {
  const checkedAt = new Date(now).toISOString();
  if (!config.enabled) return disabled(checkedAt);
  const accessToken = await apiKeyFor(ctx, "openai-codex", config.models);
  if (!accessToken) return unknown(checkedAt, "auth-unavailable");
  const accountId = extractCodexAccountId(accessToken);
  if (!accountId) return unknown(checkedAt, "auth-invalid");
  const response = await requestJson(CODEX_USAGE_URL, accessToken, timeoutMs, {
    "chatgpt-account-id": accountId,
    originator: "pi",
  });
  if (!response.ok) return unknown(checkedAt, response.code);
  const windows = parseCodexUsage(response.value, now);
  return windows ? { state: "ok", checkedAt, windows } : unknown(checkedAt, "invalid-response");
}

function unknownStatus(now: number, code: string): QuotaStatusDocument {
  const checkedAt = new Date(now).toISOString();
  return {
    schemaVersion: QUOTA_STATUS_VERSION,
    generatedAt: checkedAt,
    providers: {
      zhipu: unknown(checkedAt, code),
      deepseek: unknown(checkedAt, code),
      "openai-codex": unknown(checkedAt, code),
    },
    budget: { state: "unknown", plansWritten: 0, code },
  };
}

function statusTag(status: QuotaStatusDocument): string {
  const glm = status.providers.zhipu.windows?.[0];
  // GLM display keeps the 5h bucket (the tightest, most actionable number). Codex has no real
  // 5h cap right now, so show its weekly window instead to avoid a misleading percentage.
  const codex = status.providers["openai-codex"].windows?.find((window) => window.id === "weekly")
    ?? status.providers["openai-codex"].windows?.[0];
  const deepseek = status.providers.deepseek;
  const glmText = glm ? `GLM ${Math.round(glm.remainingRatio * 100)}%` : "GLM ?";
  const deepseekText = deepseek.balanceCny === undefined ? "DS ?" : `DS ¥${deepseek.balanceCny.toFixed(2)}`;
  const codexText = codex ? `Codex ${Math.round(codex.remainingRatio * 100)}%` : "Codex ?";
  return `💳 ${glmText} · ${deepseekText} · ${codexText}`;
}

/** True when any enabled provider would currently emit a hard-stop budget plan. */
function exhaustedPlansActive(status: QuotaStatusDocument, config: QuotaProbeConfig): boolean {
  const windowsExhausted = (provider: ProviderStatus | undefined, cfg: ProviderConfig): boolean => {
    if (!provider || provider.state !== "ok" || !provider.windows) return false;
    return provider.windows.some(
      (window) => (cfg.fiveHourEnabled || window.id !== "five-hour") && window.remainingRatio <= cfg.reserveRatio,
    );
  };
  const deepseek = status.providers.deepseek;
  const deepseekExhausted =
    config.providers.deepseek.enabled &&
    deepseek.state === "ok" &&
    (deepseek.available === false ||
      (deepseek.balanceCny !== undefined && deepseek.balanceCny <= config.providers.deepseek.hardStopBalanceCny));
  return (
    windowsExhausted(status.providers.zhipu, config.providers.zhipu) ||
    windowsExhausted(status.providers["openai-codex"], config.providers["openai-codex"]) ||
    deepseekExhausted
  );
}

/**
 * Project-local quota adapter. It never reads auth.json, logs token material, or sends any
 * prompt/session data. Only a provider-specific bearer token is used for the three read-only
 * endpoints during an explicit refresh or session startup.
 */
export default function quotaProbe(pi: ExtensionAPI): void {
  let lastRefreshAt = 0;
  let lastResult: RefreshResult | undefined;
  let lastConfig: QuotaProbeConfig | undefined;
  let refreshInFlight: Promise<RefreshResult | undefined> | undefined;

  const refresh = async (ctx: ExtensionContext, force: boolean): Promise<RefreshResult> => {
    const now = Date.now();
    const file = paths(ctx);
    let config: QuotaProbeConfig | undefined;
    try {
      config = parseQuotaProbeConfig(readJsonFile(file.config));
    } catch {
      const status = unknownStatus(now, "config-read-failed");
      writeJsonAtomically(file.status, status);
      return { status };
    }
    if (!config) {
      const status = unknownStatus(now, "config-invalid");
      writeJsonAtomically(file.status, status);
      return { status };
    }
    if (!force && lastResult && now - lastRefreshAt < config.ttlMs) return lastResult;

    const [zhipu, deepseek, codex] = await Promise.all([
      refreshZhipu(ctx, config.providers.zhipu, config.timeoutMs, now),
      refreshDeepSeek(ctx, config.providers.deepseek, config.timeoutMs, now),
      refreshCodex(ctx, config.providers["openai-codex"], config.timeoutMs, now),
    ]);
    const status: QuotaStatusDocument = {
      schemaVersion: QUOTA_STATUS_VERSION,
      generatedAt: new Date(now).toISOString(),
      providers: { zhipu, deepseek, "openai-codex": codex },
      budget: { state: "unknown", plansWritten: 0 },
    };

    const plans = buildQuotaBudgetPlans(config, status.providers, now);
    try {
      const merged = mergeRouterBudget(readJsonFile(file.budget), plans, now);
      if (!merged) {
        status.budget = { state: "unknown", plansWritten: 0, code: "budget-invalid" };
      } else {
        writeJsonAtomically(file.budget, merged);
        status.budget = { state: "ok", plansWritten: plans.length };
      }
    } catch {
      status.budget = { state: "unknown", plansWritten: 0, code: "budget-write-failed" };
    }
    writeJsonAtomically(file.status, status);
    lastRefreshAt = now;
    lastResult = { status, config };
    lastConfig = config;
    return lastResult;
  };

  pi.on("session_start", async (_event, ctx) => {
    const result = await refresh(ctx, false);
    ctx.ui.setStatus("quota", statusTag(result.status));
  });

  pi.registerCommand("quota-status", {
    description: "Show local GLM, DeepSeek, and Codex quota status without network refresh",
    handler: async (_args, ctx) => {
      const result = lastResult ?? { status: unknownStatus(Date.now(), "not-refreshed") };
      ctx.ui.notify(formatQuotaStatus(result.status), result.status.budget.state === "ok" ? "info" : "warning");
    },
  });

  pi.registerCommand("quota-refresh", {
    description: "Refresh GLM, DeepSeek, and configured Codex quota status; applies to the next Auto prompt",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("quota", "💳 refreshing…");
      const result = await refresh(ctx, true);
      ctx.ui.setStatus("quota", statusTag(result.status));
      const level = result.status.budget.state === "ok" ? "info" : "warning";
      ctx.ui.notify(`${formatQuotaStatus(result.status)}\nApplies on the next pi-router/auto prompt.`, level);
    },
  });

  // Auto-refresh once the TTL elapses so quota stays current during a long session without
  // requiring a manual /quota-refresh. Fire-and-forget: never blocks this turn, dedups
  // concurrent refreshes, and any failure is already fail-safe (unknown, model unaffected).
  // While a provider is hard-stopped, the retry window shrinks so a recovered Codex/GLM window
  // un-blocks the models on the very next input instead of waiting out the full TTL.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!lastConfig || !lastRefreshAt) return { action: "continue" };
    const exhausted = lastResult ? exhaustedPlansActive(lastResult.status, lastConfig) : false;
    const effectiveTtlMs = exhausted ? EXHAUSTED_RETRY_MS : lastConfig.ttlMs;
    if (Date.now() - lastRefreshAt < effectiveTtlMs) return { action: "continue" };
    if (!refreshInFlight) {
      refreshInFlight = refresh(ctx, false)
        .then((result) => {
          // Keep the status bar in sync with the refreshed file; UI must not go stale
          // between session_start and the next explicit /quota-refresh.
          ctx.ui.setStatus("quota", statusTag(result.status));
          return result;
        })
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = undefined;
        });
    }
    return { action: "continue" };
  });
}
