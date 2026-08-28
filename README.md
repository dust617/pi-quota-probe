# pi-quota-probe

[Pi coding agent](https://github.com/earendil-works/pi) 的套餐配额探测扩展：以**只读**方式查询 GLM Coding Plan（5 小时 / 周积分）、DeepSeek 余额、Codex 订阅用量，并把归一化后的剩余额度写入 `router-budget.json`，供 [pi-model-auto](https://www.npmjs.com/package/pi-model-auto) 在自动选模时调整影子价格——额度充裕的模型更便宜（优先消耗订阅，避免过期浪费），额度紧张的模型更贵（保护余量），余额/积分触底可硬停。

## 特性

- **三个 provider 适配器**
  - `zhipu`：Coding Plan 5h / 周积分窗口（已验证的只读额度端点）
  - `deepseek`：`GET /user/balance` 余额，低于阈值告警 / 硬停
  - `openai-codex`：5h / 周用量窗口。**使用未公开接口，默认关闭**，需在配置中显式 `enabled: true`；接口失效或字段变化时仅标记 `unknown`，**不会**排除 Codex
- **零凭据落盘**：认证仅通过 Pi `modelRegistry` 在运行时解析；不读 `auth.json`，状态/预算文件不含 token、account id 或原始响应
- **失败安全**：探测失败 = `unknown`，不阻塞、不误熔断
- **TTL 后台刷新**：超过 TTL 后在下一次用户输入时后台重探（不阻塞本轮，并发去重）
- **Codex 富余加速（surplusBoost）**：剩余 ≥ 阈值且未落后窗口进度时，注入固定折扣因子的预算计划，促进订阅消耗；落入保护区间或低于恢复线后自动回到自然定价
- **命令**：`/quota-status`（脱敏状态）、`/quota-refresh`（强制刷新）

## 工作原理

```
quota-probe ──写──▶ <项目>/.pi/router-budget.json ◀──每轮自动路由输入前重读── pi-model-auto
     │                                                                 (影子价 = costCoef × 分时系数 × 配额系数)
     └──写──▶ <项目>/.pi/quota-status.json（脱敏状态）
```

预算计划消费端公式（pi-model-auto 原生支持）：

```
factor = clamp(1 − 1.25 × (remainingRatio − (1 − periodProgress)), 0.35, 2.5)
```

surplusBoost 通过 `remainingRatio = 1 − (1 − targetFactor) / 1.25`、`periodProgress = 0` 把因子精确钉在目标值，无需修改 pi-model-auto。

## 安装

```bash
git clone https://github.com/dust617/pi-quota-probe.git
cd pi-quota-probe && npm install
```

在 Pi 全局 `~/.pi/agent/settings.json` 的 `packages` 中加入本仓库 `quota-probe/index.ts` 的绝对路径，**置于 `npm:pi-model-auto` 之前**，使预算先于路由就绪：

```json
{
  "packages": [
    "D:/pi-quota-probe/quota-probe/index.ts",
    "npm:pi-model-auto"
  ]
}
```

复制 `examples/quota-probe.example.json` 到你的项目 `<project>/.pi/quota-probe.json` 并按需调整。

## 配置

| 字段 | 说明 | 默认 |
|---|---|---|
| `ttlMs` | 探测结果缓存时长 | `1200000`（20 分钟） |
| `timeoutMs` | 单个 provider 请求超时 | `15000` |
| `providers.*.enabled` | 是否启用该 provider | codex 默认 `false`（未公开接口需显式开启） |
| `providers.*.models` | 该 provider 覆盖的路由模型列表 | — |
| `providers.*.reserveRatio` | 保留比例，配合 `hardStop` 触底排除 | `0.05` |
| `providers.*.fiveHourEnabled` | 5 小时窗口是否计入预算与硬停（Codex 默认 `false`：仅周窗口驱动定价；若你的套餐 5h 窗口真实生效，设为 `true`） | codex `false`，其余 `true` |
| `providers.deepseek.warningBalanceCny` | 低余额告警线（CNY） | `5` |
| `providers.deepseek.hardStopBalanceCny` | 硬停线（CNY） | `2` |
| `providers.*.surplusBoost.minRemainingRatio` | 富余加速的最低剩余比例（低于即恢复自然定价） | `0.5` |
| `providers.*.surplusBoost.targetFactor` | 加速时的影子价因子（越小越优先） | `0.7` |

## 开发

```bash
npm run check   # tsc --noEmit
npm test        # 编译 + node --test
```

## 隐私声明

本扩展不读取、不输出、不持久化任何凭据。provider 适配器只保留成功/失败状态、窗口剩余比例与重置时间；原始 API 响应在解析后即丢弃。Codex 用量接口为未公开端点，随时可能变化——这也是它默认关闭的原因。

## License

[MIT](LICENSE)
