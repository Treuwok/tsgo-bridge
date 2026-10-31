# tsgo-lsp：Claude Code 的 TypeScript 7 LSP 外掛設計

- 日期：2026-10-31
- 狀態：設計完成，等待確認後實作
- 目標：讓 Claude Code 改用 TypeScript 7 原生 LSP（tsgo），在不犧牲型別錯誤提示的前提下，大幅降低每個 session 的記憶體用量，並讓閒置的 session 幾乎不佔記憶體。

---

## 1. 背景

- 掃描結果：3 個 Claude Code session 透過官方 `typescript-lsp` 外掛（typescript-language-server + tsserver 6）各開一個 tsserver，合計約 **7.5 GB**（3.6 / 2.6 / 1.3 GB）。
- 官方外掛沒有設定記憶體上限；也有人回報單一 tsserver 長到 61.5 GB。
- TypeScript 7（Go 原生版，2026-07 GA）內建 LSP：`tsc --lsp --stdio`。

## 2. 網路研究摘要

| 主題 | 發現 | 來源 |
|---|---|---|
| TS 7 不推送檔案診斷 | 單一檔案的錯誤只能用 pull（`textDocument/diagnostic`）取得，push 只用在 tsconfig 錯誤 | [microsoft/TypeScript#63928](https://github.com/microsoft/TypeScript/issues/63928)（Open，修正在 PR #63921）、[typescript-go#2118](https://github.com/microsoft/typescript-go/pull/2118) |
| Claude Code 不支援 pull | 只接收 `publishDiagnostics` | [anthropics/claude-code#101041](https://github.com/anthropics/claude-code/issues/101041)（Open） |
| 現成 tsgo 外掛 | [pete-woods/claude-typescript-lsp](https://github.com/pete-woods/claude-typescript-lsp)（README 承認沒有錯誤提示）、[amaiko-ai/tsgo-lsp](https://github.com/amaiko-ai/tsgo-lsp)（專案是 TS 6 時會退回 tsserver）；**都沒有解決錯誤提示的問題** | — |
| 轉接器（proxy）前例 | [stay-fresh-lsp-proxy](https://www.claudepluginhub.com/marketplaces/iloom-ai-stay-fresh-lsp-proxy)、[wait-for-lsp](https://www.claudepluginhub.com/plugins/tonywu20-wait-for-lsp)：夾在 Claude Code 和 LSP 中間過濾診斷 | — |
| 閒置停止 + 延遲重啟前例 | [fleet-lsp#22](https://github.com/fredericrous/fleet-lsp/pull/22)、[rimz#501](https://github.com/rimio-ai/rimz/pull/501)、[oh-my-openagent#11753](https://github.com/code-yeongyu/oh-my-openagent/issues/11753) | — |
| 重啟的常見坑 | 重啟後沒有重送 didOpen，server 不知道已開啟的檔案（[nexus-code#43](https://github.com/moreih29/nexus-code/pull/43)、[agent-lsp#54](https://github.com/blackwell-systems/agent-lsp/issues/54)）；閒置停止不能被當成當機；正在處理的請求要明確收尾 | — |
| pull→push 橋接的坑 | pull 請求一定要有回應，否則 server 會卡住（[mql-language-server#99](https://github.com/davalillo/mql-language-server/pull/99)）；不要把錯誤當成「沒有診斷」 | — |

## 3. 實驗與結果（全部在本機 Windows 11、Claude Code 2.1.316、TS 7.0.2 上實測）

### E1 批次型別檢查（19 個 tsconfig，TS 6.0.3 vs 7.0.2）
- TS 7 快 3–6 倍；記憶體少 5–15%。
- TS 6 的錯誤 TS 7 全部抓到；TS 7 另外多 5 個（2 種：TS2883 型別無法被引用、TS2454 使用前未賦值），都是 TS 7 比較嚴格，不是誤判。

### E2 LSP 負載測試（monorepo 8 個套件各開 1 個檔案）

| | TS 6（現行） | TS 7 原生 | TS 7 + 轉接器 |
|---|---|---|---|
| Peak 記憶體 | 3.9 GB | 1.6 GB | 1.9 GB |
| 編輯後錯誤提示 | ✅ 1.5–8 s | ❌ 沒有 | ✅ 0.1–2.4 s |
| 7 種導航請求 | ✅ | ✅ | ✅ |

### E3 錄下真實 Claude Code 的 LSP 通訊（headless 和互動模式都測過）
- `initialize` 能力：**沒有** `textDocument.diagnostic`；`didChangeWatchedFiles.dynamicRegistration=false`；`workspace.configuration=false`；`publishDiagnostics.versionSupport=false`；`positionEncodings=["utf-16"]`。
- server 是延遲啟動的：第一次 LSP 工具呼叫或第一次編輯時才啟動。只做 Read 不會送 didOpen。
- 第一次編輯某檔案：送 `didOpen`（內容是改好的），**不送** didSave。之後的編輯：`didChange`（全文）+ `didSave`。互動模式也會送 didChange（2.1.316 沒有重現 #79744）。
- 不送 `didClose`；session 結束時送 `shutdown` / `exit`。
- `client/registerCapability` 一律忽略。
- 推送來的錯誤先存進暫存區，**下一次呼叫模型前一次取走，不會等**。所以錯誤要盡快推送，晚到就要等下一輪；空的錯誤清單會被忽略。
- 結果：TS 7 + 轉接器在 headless 和互動模式下，Claude 都正確收到全部錯誤，包括跨檔案的連帶錯誤。同一情境下 TS 6 有一次因為推送太晚，漏掉了新的錯誤。

### E4 檔案監看
- 以 Claude 的能力宣告（client 不負責監看）啟動時，**tsgo 會自己監看硬碟**，2 秒內就發現檔案變動。
- 如果 client 宣稱會負責監看，tsgo 就交給 client，而且要求監看 `c:/users/<user>/appdata/**/*` 這種超大範圍。
- → 轉接器**不能**宣告檔案監看的能力。

### E5 閒置停止 / 延遲重啟 / 當機（原型 v2，watsons monorepo）
| 項目 | 結果 |
|---|---|
| 閒置停止 | 1,079 MB → **58 MB**（只剩轉接器本身） |
| 停止後第一個請求（重啟 + 重送 3 個檔案） | 0.8–0.9 s，結果正確 |
| 停止期間送來的局部修改 | 重啟時正確帶入，0.84 s 推送新錯誤 |
| 重啟後重複推送 | 0（有去重） |
| 強制殺掉 tsgo 後立刻送 references | 自動重啟並重試，0.86 s 拿到正確結果 |
| 抓到的 bug | client 的 `initialized` 被轉發，轉接器自己又送一次，tsgo 收到兩次就 panic → 已修 |

### E6 GOMEMLIMIT
| 設定 | Peak | 錯誤提示延遲 | references |
|---|---|---|---|
| 不設 | 1,892 MB | 0.1–1.1 s | 205 ms |
| 1 GiB | 1,689 MB（−11%） | 0.25–1.9 s | 2,005 ms |
| 600 MiB | 1,686 MB | 0.26–2.0 s | 1,890 ms |

→ **不設**：只省 11%，速度卻慢 2–10 倍。真正能省記憶體的是閒置停止。

## 4. 需求

- R1 錯誤提示：Claude 編輯 `.ts/.tsx/.js/.mjs/.cjs/.mts/.cts` 後，在下一輪模型呼叫前收到正確且最新的錯誤。
- R2 導航：hover / definition / references / implementation / documentSymbol / workspaceSymbol / callHierarchy 都能用。
- R3 記憶體：使用中的 session ≤ 約 2 GB；閒置超過 N 分鐘的 session ≤ 約 60 MB。
- R4 透明：閒置停止、重啟、當機對 Claude 不可見（不回錯誤，不重複推送錯誤）。
- R5 不動專案：不修改任何專案的 package.json 或 tsconfig；外掛自帶 TypeScript 7。
- R6 可回退：一行設定就能切回官方 `typescript-lsp`。
- R7 可觀察：可以開啟 log 方便排查。

## 5. 架構

```
Claude Code ──stdio──► node proxy.mjs ──stdio──► node <plugin>/node_modules/typescript/bin/tsc --lsp --stdio
 (push only)            │ 文件狀態（全文 + 版本）              (TS 7 native, tsc.exe)
                        │ pull → push + 去重
                        │ 閒置停止 / 延遲重啟 / 重送
                        └ 當機重試（唯讀請求）
```

### 5.1 外掛結構（本機 marketplace）
```
~/.claude/local-plugins/
├── .claude-plugin/marketplace.json        # 本機 marketplace "local-plugins"
└── tsgo-lsp/
    ├── .claude-plugin/plugin.json
    ├── .lsp.json                           # command: node, args: [${CLAUDE_PLUGIN_ROOT}/proxy.mjs]
    ├── proxy.mjs                           # 轉接器（零依賴，單一檔案）
    ├── package.json                        # dependencies: typescript 7.0.2（固定版本）
    ├── node_modules/typescript/…           # 安裝時 npm ci
    ├── test/                               # 自動化測試（lspc + 情境腳本 + 測試專案）
    └── README.md
```

`.lsp.json`：
```json
{ "typescript": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/proxy.mjs"],
    "env": { "TSGO_IDLE_MS": "600000" },
    "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
                             ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript" },
    "startupTimeout": 30000,
    "restartOnCrash": true,
    "maxRestarts": 5 } }
```

### 5.2 轉接器狀態機
```
          initialize
 (none) ───────────► starting ──init 回應──► ready ◄─────────────┐
                        ▲                     │  閒置 > TSGO_IDLE_MS 且沒有請求在處理
                        │ 有新訊息             ▼                  │
                       idle ◄──── exit ─── stopping              │
                        ▲                                         │
                        └──── 意外 exit（當機）── 唯讀請求排隊重試 ┘
```

### 5.3 訊息處理規則

| 方向 | 訊息 | 處理 |
|---|---|---|
| C→P | `initialize` | 快取參數；加上 `textDocument.diagnostic` 後送給 tsgo；回給 client 的結果**移除 `diagnosticProvider`** |
| C→P | `initialized` | **吞掉**（轉接器每次啟動都自己送，送兩次會讓 tsgo panic） |
| C→P | didOpen / didChange（全文 + 局部）/ didClose | 一律更新文件狀態；ready 時轉發並排程 pull；不是 ready 時不轉發，靠重送處理 |
| C→P | didSave | ready 時轉發並排程 pull |
| C→P | 一般請求 | ready 時轉發並記錄成「處理中」；不是 ready 時排隊並觸發啟動 |
| C→P | `shutdown` | ready 時轉發；idle 時直接回 `null` |
| C→P | `exit` / stdin 結束 | 結束 tsgo，然後結束自己 |
| P→S | （自己發的）`textDocument/diagnostic` | debounce 50 ms；先處理剛改的檔案，再處理其他已開啟的檔案（跨檔錯誤）；結果是 `full` 且和上次不同才推送 |
| S→P | `client/registerCapability`、`workspace/configuration`、`workspace/diagnostic/refresh` | 轉接器自己回應（refresh 會觸發全部重新 pull），不轉給 client |
| S→P | `publishDiagnostics`（tsconfig） | 去重後轉發 |
| S→P | 回應 | 屬於轉接器自己的請求就自己處理；其他從「處理中」移除後轉給 client |
| 事件 | 閒置停止 | `shutdown` → `exit` → 5 秒後強制結束 |
| 事件 | 意外結束 | 唯讀請求（hover、definition 等）排隊、重啟後重試一次；其他請求回 `-32803`；下一個訊息觸發重啟 |
| 事件 | 重啟完成 | 送 `initialized` → 用最新內容對每個已開啟的檔案重送 didOpen → 清空排隊 → 全部重新 pull（去重會擋掉沒變的結果） |

### 5.4 設定（環境變數，寫在 `.lsp.json` 的 `env`）
| 變數 | 預設 | 說明 |
|---|---|---|
| `TSGO_IDLE_MS` | 600000（10 分鐘） | 0 = 不做閒置停止 |
| `TSGO_DIAG_DEBOUNCE_MS` | 50 | Claude 的 didChange 和 didSave 幾乎同時送，50 ms 足夠合併 |
| `TSGO_PROXY_LOG` | 未設定 | 設成檔案路徑就寫 log |
| `TSGO_TSC` | 外掛內建 | 可以改指向其他 TS 7 版本 |
| `GOMEMLIMIT` | 不設 | 實驗顯示不值得設 |

## 6. 實作計畫

1. 把原型 v2 整理成 `proxy.mjs`，處理已知的小問題：
   - 收到 client 的 `shutdown` 時，把狀態設成 stopping，避免被誤判成當機。
   - stdin 和 stdout 的錯誤處理（EPIPE）。
   - log 自動輪替（大小上限）。
2. 自動化測試：`node --test` 搭配 E3/E5 的情境腳本和小型測試專案，涵蓋去重、重送、局部修改、當機重試、shutdown。
3. 建立本機 marketplace 和外掛，執行 `npm ci`，再用 `claude plugin validate` 驗證。
4. 單一 session 實測：`claude --plugin-dir ...` 在 virtual-human-watsons 跑一次編輯、導航、閒置 10 分鐘後再用。
5. 正式切換：`claude plugin marketplace add ~/.claude/local-plugins` → `claude plugin install tsgo-lsp@local-plugins` → `claude plugin disable typescript-lsp@claude-plugins-official`。
6. 回退：`claude plugin enable typescript-lsp@claude-plugins-official` + `claude plugin disable tsgo-lsp@local-plugins`。
7. 之後追蹤：TypeScript PR #63921 合併，或 Claude Code #101041 實作 pull 時，評估拿掉 pull→push（閒置停止仍然有價值）。

## 7. 風險與限制

| 風險 | 影響 | 對策 |
|---|---|---|
| TS 7 比 TS 6 嚴格 | Claude 可能看到專案 CI（TS 6）不會報的錯誤（目前已知 5 個） | 在 README 註明；可以另外修掉 |
| tsconfig 的 TS plugin（如 Next.js `{ "name": "next" }`）不會載入 | 只少了 Next.js 的額外提示 | 可以接受 |
| Vue / Svelte / Astro 不支援 | 這個 repo 沒有用到 | — |
| 閒置後第一個請求要多等約 1 秒 | 輕微 | 閒置時間可以調整 |
| 錯誤晚於 Claude 的下一輪才送到 | 要等下一輪才看到（TS 6 也一樣） | debounce 降到 50 ms，先處理剛改的檔案 |
| Claude Code 改變 LSP client 行為 | 轉接器假設失效 | 測試涵蓋協定層級；升級後重跑 E3 錄製 |
| 轉接器本身當掉 | Claude 會依 `restartOnCrash` 重開 | 設 `maxRestarts`；log 記錄 |

## 8. 不做的事（以及原因）
- **跨 session 共用 tsgo**：只有同一目錄的 session 能共用；LSP 是一對一的協定，多個 session 共用同一份文件狀態會互相覆蓋。閒置停止的效益更大，也沒有這些風險。
- **GOMEMLIMIT**：見 E6。
- **由轉接器負責檔案監看**：見 E4，tsgo 自己會監看。
