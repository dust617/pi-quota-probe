import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildQuotaBudgetPlans,
  DEFAULT_QUOTA_PROBE_CONFIG,
  extractCodexAccountId,
  formatQuotaStatus,
  mergeRouterBudget,
  parseCodexUsage,
  parseDeepSeekBalance,
  parseQuotaProbeConfig,
  parseZhipuQuota,
  QUOTA_STATUS_VERSION,
  readJsonFile,
  writeJsonAtomically,
  type ProviderStatus,
} from "../quota-probe/core.js";

const NOW = Date.parse("2026-08-27T10:00:00.000Z");

function okStatus(windows: ProviderStatus["windows"]): ProviderStatus {
  return { state: "ok", checkedAt: new Date(NOW).toISOString(), windows };
}

test("quota probe config is bounded and Codex remains explicitly configurable", () => {
  const defaults = parseQuotaProbeConfig(undefined);
  assert.deepEqual(defaults, DEFAULT_QUOTA_PROBE_CONFIG);
  assert.equal(defaults?.providers["openai-codex"].enabled, false, "missing config must not call an undocumented endpoint");

  const configured = parseQuotaProbeConfig({
    ...DEFAULT_QUOTA_PROBE_CONFIG,
    ttlMs: 60_000,
    providers: {
      ...DEFAULT_QUOTA_PROBE_CONFIG.providers,
      "openai-codex": { ...DEFAULT_QUOTA_PROBE_CONFIG.providers["openai-codex"], enabled: true },
    },
  });
  assert.equal(configured?.ttlMs, 60_000);
  assert.equal(configured?.providers["openai-codex"].enabled, true);

  // GLM has a real 5h cap; Codex currently does not (fiveHourEnabled off by default, re-enablable).
  assert.equal(configured?.providers.zhipu.fiveHourEnabled, true);
  assert.equal(configured?.providers["openai-codex"].fiveHourEnabled, false);
  assert.equal(
    parseQuotaProbeConfig({
      ...DEFAULT_QUOTA_PROBE_CONFIG,
      providers: {
        ...DEFAULT_QUOTA_PROBE_CONFIG.providers,
        "openai-codex": { ...DEFAULT_QUOTA_PROBE_CONFIG.providers["openai-codex"], fiveHourEnabled: true },
      },
    })?.providers["openai-codex"].fiveHourEnabled,
    true,
  );

  assert.equal(parseQuotaProbeConfig({ schemaVersion: 1, providers: {} }), undefined, "partial config must not silently enable providers");
});

test("GLM Coding Plan response yields the 5h and weekly budget windows", () => {
  const windows = parseZhipuQuota({
    code: 200,
    data: {
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, currentValue: 160, usage: 2000, remaining: 1840, nextResetTime: NOW + 5 * 60 * 60 * 1_000 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, currentValue: 160, usage: 10000, remaining: 9840, nextResetTime: NOW + 7 * 24 * 60 * 60 * 1_000 },
      ],
    },
  }, NOW);
  assert.equal(windows?.length, 2);
  assert.deepEqual(windows?.map((window) => window.id), ["five-hour", "weekly"]);
  assert.equal(windows?.[0]?.remainingRatio, 0.92);
  assert.equal(windows?.[1]?.remainingRatio, 0.984);
  assert.equal(parseZhipuQuota({ data: { limits: [] } }, NOW), undefined);
});

test("DeepSeek balance parser aggregates CNY only and preserves availability", () => {
  assert.deepEqual(parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "64.31" },
      { currency: "USD", total_balance: "99.00" },
      { currency: "CNY", total_balance: "1.17" },
    ],
  }), { available: true, balanceCny: 65.48 });
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [] }), undefined);
});

test("Codex usage parser handles the documented primary and secondary windows", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: (NOW + 5 * 60 * 60 * 1_000) / 1_000 },
      secondary_window: { used_percent: 55, limit_window_seconds: 604_800, reset_at: (NOW + 7 * 24 * 60 * 60 * 1_000) / 1_000 },
    },
  }, NOW);
  assert.equal(windows?.[0]?.id, "five-hour");
  assert.equal(windows?.[0]?.remainingRatio, 0.8);
  assert.equal(windows?.[1]?.id, "weekly");
  assert.equal(windows?.[1]?.remainingRatio, 0.45);
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 101 } } }, NOW), undefined);
});

test("Codex account id is transiently read from a synthetic access token only", () => {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test-only" },
  })).toString("base64url");
  assert.equal(extractCodexAccountId(`header.${payload}.signature`), "acct-test-only");
  assert.equal(extractCodexAccountId("not-a-jwt"), undefined);
});

test("successful observations generate probe plans while low DeepSeek balance hard-stops only its model", () => {
  const glmWindows = parseZhipuQuota({
    data: {
      limits: [
        { unit: 3, number: 5, usage: 2000, remaining: 1000, nextResetTime: NOW + 5 * 60 * 60 * 1_000 },
        { unit: 6, number: 1, usage: 10000, remaining: 9000, nextResetTime: NOW + 7 * 24 * 60 * 60 * 1_000 },
      ],
    },
  }, NOW)!;
  const codexWindows = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 10, reset_at: (NOW + 5 * 60 * 60 * 1_000) / 1_000 },
      secondary_window: { used_percent: 10, reset_at: (NOW + 7 * 24 * 60 * 60 * 1_000) / 1_000 },
    },
  }, NOW)!;
  const config = JSON.parse(JSON.stringify(DEFAULT_QUOTA_PROBE_CONFIG));
  config.providers["openai-codex"].enabled = true;
  const plans = buildQuotaBudgetPlans(config, {
    zhipu: okStatus(glmWindows),
    deepseek: { state: "ok", checkedAt: new Date(NOW).toISOString(), available: true, balanceCny: 2, warning: true },
    "openai-codex": okStatus(codexWindows),
  }, NOW);
  assert.deepEqual(plans.map((plan) => plan.id), [
    "quota-probe:zhipu-five-hour",
    "quota-probe:zhipu-weekly",
    "quota-probe:codex-weekly",
    "quota-probe:deepseek-balance",
  ]);
  assert.equal(plans.at(-1)?.available, false);

  // Re-enabling the codex 5h window restores its five-hour budget plan.
  config.providers["openai-codex"].fiveHourEnabled = true;
  const withFiveHour = buildQuotaBudgetPlans(config, {
    zhipu: okStatus(glmWindows),
    deepseek: { state: "ok", checkedAt: new Date(NOW).toISOString(), available: true, balanceCny: 2, warning: true },
    "openai-codex": okStatus(codexWindows),
  }, NOW);
  assert.ok(withFiveHour.some((plan) => plan.id === "quota-probe:codex-five-hour"));
});

test("codex surplus boost discounts only while quota is plentiful and not behind schedule", () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_QUOTA_PROBE_CONFIG));
  config.providers["openai-codex"].enabled = true;
  // The spend-down boost is a five-hour-window concept; enable that window for this test.
  config.providers["openai-codex"].fiveHourEnabled = true;
  const build = (primary: Record<string, unknown>) =>
    buildQuotaBudgetPlans(config, {
      zhipu: { state: "unknown", checkedAt: new Date(NOW).toISOString() },
      deepseek: { state: "unknown", checkedAt: new Date(NOW).toISOString() },
      "openai-codex": okStatus(parseCodexUsage({ rate_limit: { primary_window: primary } }, NOW)!),
    }, NOW);

  // Half the window elapsed with 95% still left -> ahead of schedule, plentiful: boost fires.
  const surplus = build({ used_percent: 5, reset_after_seconds: 2.5 * 60 * 60, limit_window_seconds: 5 * 60 * 60 });
  const boost = surplus.find((plan) => plan.id === "quota-probe:codex-five-hour-surplus-boost");
  assert.ok(boost, "expected a surplus-boost plan");
  // Consumer: factor = 1 − 1.25·(remaining − (1−progress)); remaining=1 + progress=0.24 ⇒ exactly 0.70.
  assert.equal(boost.remainingRatio, 1);
  assert.ok(Math.abs((boost.periodProgress ?? 0) - (1 - 0.7) / 1.25) < 1e-9, String(boost.periodProgress));
  assert.equal(boost.hardStop, false);
  assert.equal(Math.max(0.35, Math.min(2.5, 1 - 1.25 * (1 - (1 - 0.24)))), 0.7);
  assert.ok(surplus.some((plan) => plan.id === "quota-probe:codex-five-hour"));

  // Burning faster than schedule early in the window (natural factor > 1) suppresses the boost
  // even though quota is plentiful — protection always wins over spend-down.
  const protective = build({ used_percent: 15, reset_after_seconds: 4.5 * 60 * 60, limit_window_seconds: 5 * 60 * 60 });
  assert.ok(!protective.some((plan) => String(plan.id).includes("surplus-boost")));

  // Below the restore floor (~50%), pricing returns to the natural plan only.
  const depleted = build({ used_percent: 55, reset_after_seconds: 4.45 * 60 * 60, limit_window_seconds: 5 * 60 * 60 });
  assert.ok(!depleted.some((plan) => String(plan.id).includes("surplus-boost")));

  // Default codex config (fiveHourEnabled=false) emits no 5h plan, boost or hard-stop from it.
  const defaultCfg = JSON.parse(JSON.stringify(DEFAULT_QUOTA_PROBE_CONFIG));
  defaultCfg.providers["openai-codex"].enabled = true;
  const noFiveHour = buildQuotaBudgetPlans(defaultCfg, {
    zhipu: { state: "unknown", checkedAt: new Date(NOW).toISOString() },
    deepseek: { state: "unknown", checkedAt: new Date(NOW).toISOString() },
    "openai-codex": okStatus(parseCodexUsage({ rate_limit: {
      primary_window: { used_percent: 5, reset_at: (NOW + 5 * 60 * 60 * 1_000) / 1_000 },
      secondary_window: { used_percent: 10, reset_at: (NOW + 7 * 24 * 60 * 60 * 1_000) / 1_000 },
    } }, NOW)!),
  }, NOW);
  assert.ok(noFiveHour.some((plan) => plan.id === "quota-probe:codex-weekly"));
  assert.ok(!noFiveHour.some((plan) => String(plan.id).includes("codex-five-hour")));
});

test("budget merge preserves manual plans and removes stale probe entries only", () => {
  const merged = mergeRouterBudget({
    schemaVersion: 1,
    updatedAt: "old",
    plans: [
      { id: "manual-week", models: ["manual/model"], remainingRatio: 0.7 },
      { id: "quota-probe:old", models: ["old/model"] },
    ],
  }, [{
    id: "quota-probe:new",
    source: "quota-probe",
    enabled: true,
    models: ["new/model"],
    updatedAt: new Date(NOW).toISOString(),
  }], NOW);
  assert.deepEqual(merged?.plans.map((plan) => plan.id), ["manual-week", "quota-probe:new"]);
  assert.equal(mergeRouterBudget({ schemaVersion: 99, plans: [] }, [], NOW), undefined);
});

test("runtime status output is readable and contains no account identifier", () => {
  const text = formatQuotaStatus({
    schemaVersion: QUOTA_STATUS_VERSION,
    generatedAt: new Date(NOW).toISOString(),
    providers: {
      zhipu: okStatus([{ id: "five-hour", remaining: 80, limit: 100, remainingRatio: 0.8, resetAt: new Date(NOW + 1).toISOString(), durationMs: 1 }]),
      deepseek: { state: "ok", checkedAt: new Date(NOW).toISOString(), available: true, balanceCny: 64.31 },
      "openai-codex": { state: "unknown", checkedAt: new Date(NOW).toISOString(), code: "http-404" },
    },
    budget: { state: "ok", plansWritten: 1 },
  });
  assert.match(text, /GLM: 5h 80%/);
  assert.match(text, /DeepSeek: ¥64\.31/);
  assert.match(text, /Codex: unknown \(http-404\)/);
  assert.doesNotMatch(text, /acct-test-only/);
});

test("atomic JSON helpers persist a local JSON document", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-probe-"));
  const file = path.join(root, "nested", "state.json");
  try {
    writeJsonAtomically(file, { ok: true });
    assert.deepEqual(readJsonFile(file), { ok: true });
    assert.equal(readJsonFile(path.join(root, "missing.json")), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
