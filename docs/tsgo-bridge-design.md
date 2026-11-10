# tsgo-bridge：跨平台、跨 Agent 的 TypeScript 7 程式碼智慧橋接器

- 日期：2026-10-31
- 狀態：設計（v2，取代 `tsgo-lsp-plugin-design.md` 的「實作計畫」部分；該文件保留作為實驗紀錄）
- 範圍：Windows / macOS / Linux；Claude Code 與 Codex CLI

---

## 0. 一句話

一個 Node 套件 `tsgo-bridge`，內含：
- 共用核心：管理 tsgo 的啟動、閒置停止、重啟。
- 兩個前端：給 Claude Code 的 LSP 轉接器、給 Codex 的 MCP server。
- 一個 `setup` 指令：用各 agent 官方的 CLI 一鍵安裝、診斷、移除。

## 1. 要整合成 Skill、Plugin，還是別的方式？

| Agent | 有沒有內建 LSP client | 整合方式 | 原因 |
|---|---|---|---|
| **Claude Code** | 有（plugin 的 `lspServers`） | **Plugin（LSP server）** | 這是唯一能接上 Claude「編輯後自動附上型別錯誤」和 `LSP` 工具的方式 |
| **Codex CLI 0.163** | **沒有**（[openai/codex#8745](https://github.com/openai/codex/issues/8745)、[#14799](https://github.com/openai/codex/issues/14799) 都還 open） | **MCP server + Skill** | MCP 提供工具（`ts_diagnostics`、`ts_definition` 等）；Skill 告訴 Codex「改完 TS 要呼叫 `ts_diagnostics`」 |

**只用 Skill 不夠**：Skill 只是一段寫給 agent 的指示，不能常駐一個 process，也接不上 Claude 的診斷流程。Skill 在這裡只負責「教 Codex 什麼時候用 MCP 工具」。

**Plugin 是打包方式，不是功能本身**：
- Claude 的 plugin 裝的是 LSP server。
- Codex 的 plugin 可以打包 skill 和 MCP server，但實驗顯示 Codex 0.163 **沒有啟動** plugin 內宣告的 stdio MCP server（見 §8 E7）。所以 Codex 的 MCP 改用官方的 `codex mcp add` 註冊，Skill 直接放進 skills 目錄。

## 2. 架構

```
                       ┌────────────── tsgo-bridge（Node ≥ 20，零 runtime 依賴，只依賴 typescript@7.0.2）──────────────┐
Claude Code ──LSP────► │ lsp 前端：pull→push、去重、文件狀態、initialize 改寫           │
 (plugin lspServers)   │                                                              ├──► TsgoManager（每個 workspace root 一個）
                       │                                                              │     ├ 直接 spawn 原生 tsc(.exe) --lsp --stdio
Codex ──MCP(stdio)───► │ mcp 前端：ts_diagnostics / ts_hover / ts_definition /         │     ├ 閒置停止 / 延遲重啟 / 重送 didOpen
 (codex mcp add)       │           ts_references / ts_symbols；從硬碟讀檔、管理已開檔案   │     └ 當機：唯讀請求重試一次
                       │ cli：setup / doctor / uninstall / version                    │
                       └──────────────────────────────────────────────────────────────┘
```

### 2.1 共用核心 `TsgoManager`
- **找執行檔**：`require.resolve('@typescript/typescript-${platform}-${arch}/package.json')` → `lib/tsc` 或 `lib/tsc.exe`。
  - 不經過 `typescript/bin/tsc`（node 啟動器），每個 session 少一個約 58 MB 的 node process。
  - Windows 上直接結束原生 exe 不會留下孤兒 process。
  - 找不到時可以用 `TSGO_TSC` 指定路徑，或退回用 `node typescript/bin/tsc`。
- **生命週期**：沿用原型 v2 的狀態機（idle → starting → ready → stopping），實驗 E5 已驗證。
- **結束 process**：先送 `shutdown` / `exit` → 5 秒後 `proc.kill()`（POSIX 送 SIGTERM，再 2 秒送 SIGKILL；Windows 用 TerminateProcess）。
- **跨平台規則**：
  - URI 一律用 `url.pathToFileURL` / `fileURLToPath`，不自己拼字串。
  - LSP 前端原樣保留 client 給的 URI，不做轉換。
  - spawn 時不用 shell，加上 `windowsHide: true`。
  - 位置一律用 UTF-16（Claude 宣告的就是 `utf-16`）。

### 2.2 LSP 前端（Claude Code）
規則同 v1 設計 §5.3（已實驗驗證）：吞掉 client 的 `initialized`、移除 `diagnosticProvider`、debounce 50 ms 的 pull→push、去重、server 端的請求由轉接器自己回應、不宣告檔案監看能力。

### 2.3 MCP 前端（Codex，也可以給其他 MCP client 用）

| 工具 | 輸入 | 輸出 |
|---|---|---|
| `ts_diagnostics` | `files?: string[]`（省略 = `git diff --name-only` + 未追蹤的 TS/JS 檔） | 每個檔案的錯誤（行:欄、代碼、訊息、嚴重度），上限 200 筆 |
| `ts_hover` | `file, line, column`（從 1 開始） | 型別簽名 |
| `ts_definition` / `ts_references` | `file, line, column` | 位置清單（相對路徑:行:欄 + 該行內容） |
| `ts_symbols` | `query` | workspace 的 symbol |

- **workspace root**：MCP `roots/list`（client 有支援時）→ 檔案所在的 git root → `process.cwd()`。不同 root 各自一個 TsgoManager，各自閒置停止。
- **文件同步**：每次呼叫工具時從硬碟讀檔；還沒開的送 `didOpen`，內容有變的送 `didChange`；最多保留 50 個已開檔案（LRU），超過就 `didClose`。
- **輸出要精簡**：給 agent 看的是純文字，不是原始 LSP JSON，以節省 context。

### 2.4 Codex Skill（`skills/tsgo-typecheck/SKILL.md`）
- 觸發：編輯 `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` 之後，或是需要找定義、找引用的時候。
- 指示：
  - 改完檔案、結束這輪之前，對改過的檔案呼叫 `ts_diagnostics`，把錯誤修到 0 或說明原因。
  - 找 symbol 時優先用 `ts_definition` / `ts_references`，而不是 grep。
- 放在 `$CODEX_HOME/skills/`；如果要給多個 agent 共用，也可以選 `~/.agents/skills/`。

## 3. 打包與散佈

### 3.1 Repo 結構（一個 git repo 同時是 npm 套件和 Claude 的 marketplace）
```
tsgo-bridge/
├── package.json                 # name: tsgo-bridge, bin: { "tsgo-bridge": "bin/tsgo-bridge.mjs" }
│                                #   dependencies: { "typescript": "7.0.2" }  engines: { node: ">=20" }
├── bin/tsgo-bridge.mjs          # 子指令：lsp | mcp | setup | doctor | uninstall | version
├── src/
│   ├── tsgo-manager.mjs         # 共用核心
│   ├── lsp-proxy.mjs            # Claude 前端
│   ├── mcp-server.mjs           # Codex 前端（手寫的最小 MCP stdio 實作，零依賴）
│   ├── jsonrpc.mjs              # LSP 框架（Content-Length）+ MCP 框架（換行分隔的 JSON）
│   ├── resolve-tsgo.mjs         # 依平台找原生執行檔
│   └── setup/                   # claude.mjs / codex.mjs / homes.mjs（找出 Orca profile 等設定目錄）
├── skills/tsgo-typecheck/SKILL.md
├── .claude-plugin/marketplace.json          # Claude marketplace（Codex 也讀得懂這個格式）
├── plugins/tsgo-lsp/
│   ├── .claude-plugin/plugin.json           # lspServers → node ${CLAUDE_PLUGIN_ROOT}/launch.mjs lsp
│   ├── launch.mjs                           # 找到或安裝 runtime，然後在同一個 process 裡 import 執行
│   └── README.md
├── test/                         # node --test：lspc 測試 client + fixtures + 情境（E3/E5 改寫）
└── .github/workflows/ci.yml      # matrix：windows-latest / macos-latest(arm64) / ubuntu-latest × node 20/22/24
```

### 3.2 為什麼 TypeScript 7 不放進 git
TS 7 的原生執行檔是平台專屬的（`optionalDependencies` 有 20 種 OS/架構組合），只能由 npm 在每台機器上自己裝。所以：
- **Claude plugin**：`launch.mjs` 第一次啟動時，把 runtime 安裝到 `${CLAUDE_PLUGIN_DATA}/runtime-<版本>/`，執行 `npm install --omit=dev`，約 3–5 秒。之後就直接 `import`。
  - `CLAUDE_PLUGIN_DATA` 不會因為 plugin 更新而被清掉。
  - `.lsp.json` 的 `startupTimeout` 設成 120 秒，涵蓋第一次安裝的時間。
  - `setup` 也會先幫忙裝好，所以第一次開 session 不用等。
- **Codex MCP**：`setup` 把 runtime 裝到使用者的資料目錄，再用 `codex mcp add` 寫入絕對路徑：
  - Windows：`%LOCALAPPDATA%\tsgo-bridge\<版本>`
  - macOS：`~/Library/Application Support/tsgo-bridge/<版本>`
  - Linux：`${XDG_DATA_HOME:-~/.local/share}/tsgo-bridge/<版本>`
- 找 npm 的方式要跨平台：先找 `process.execPath` 旁邊的 `npm-cli.js`（Windows 是 `node_modules/npm/bin/npm-cli.js`，POSIX 是 `../lib/node_modules/npm/bin/npm-cli.js`），找不到再用 PATH 上的 `npm`（Windows 走 `shell: true`）。

### 3.3 安裝（任何作業系統、任何電腦都一樣）
前提：Node ≥ 20（含 npm）、git，還有 Claude Code 或 Codex 至少一個。

```bash
# 一行安裝（之後如果發布到 npm，就改成 npx tsgo-bridge setup）
npx -y github:<owner>/tsgo-bridge setup
```

`setup` 會做的事（每一步都會先印出來；`--dry-run` 只印不做）：
1. **找出設定目錄**：
   - 環境變數 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，加上預設的 `~/.claude` / `~/.codex`。
   - **Orca profile**：Windows 在 `%APPDATA%\orca\claude-profiles\*\home`、`codex-accounts\*\home`；macOS 在 `~/Library/Application Support/orca/...`；Linux 在 `~/.config/orca/...`。
   - 列出找到的目錄讓使用者選，或用 `--all` 全選。
2. **Claude Code**（每個設定目錄都做一次，設好 `CLAUDE_CONFIG_DIR` 再呼叫官方 CLI）：
   - `claude plugin marketplace add <owner>/tsgo-bridge`
   - `claude plugin install tsgo-lsp@tsgo-bridge`
   - `claude plugin disable typescript-lsp@claude-plugins-official`（如果有裝的話；先記下原本的狀態，移除時才能還原）
3. **Codex**（每個 `CODEX_HOME` 都做一次）：
   - 安裝 runtime → `codex mcp add tsgo -- node <runtime>/bin/tsgo-bridge.mjs mcp`
   - 把 skill 複製到 `$CODEX_HOME/skills/tsgo-typecheck/`
4. **Prewarm + 自我測試**：跑 `doctor`。

其他指令：
- `tsgo-bridge doctor`：
  - 檢查 Node 版本、原生執行檔、能不能啟動。
  - 對內附的 fixture 專案跑一次 LSP 和 MCP 的往返測試：注入一個錯誤，確認收得到。
  - 檢查各設定目錄的 plugin 和 MCP 註冊狀態，以及官方 `typescript-lsp` 有沒有停用。
- `tsgo-bridge uninstall`：反向執行 setup，把官方 plugin 還原成原本的狀態。
- **更新**：
  - Claude：`claude plugin marketplace update tsgo-bridge`（或開 marketplace 的 autoUpdate）。
  - Codex：重跑 `setup`，它會比對版本，裝新的 runtime 並更新 `codex mcp` 的路徑。
  - 舊的 runtime 保留最近 2 版。

### 3.4 設定
| 項目 | 方式 | 預設 |
|---|---|---|
| 閒置停止 | Claude：plugin `userConfig.idle_minutes` → `.lsp.json` env `TSGO_IDLE_MS`；Codex：`codex mcp add --env TSGO_IDLE_MS=...` | 10 分鐘 |
| TS 7 版本 | 跟著 tsgo-bridge 版本（固定在 package.json），升級 = 發新版 | 7.0.2 |
| log | `TSGO_BRIDGE_LOG=<檔案>`（輪替，5 MB × 2） | 關閉 |
| 自訂執行檔 | `TSGO_TSC=<路徑>` | 無 |
| 閒置 worktree 釋放 | 與閒置停止共用 `idle_minutes` / `TSGO_IDLE_MS`（只有 LSP 用；MCP 每個 git root 一個 TsgoManager，各自閒置停止，並沿用每個 manager 50 份文件的上限） | 10 分鐘 |

**為什麼要釋放閒置的 worktree（2026-11-10 事故）**：Claude Code 不送 `didClose`，tsgo 7.0.2 只要 project 還有開啟的檔案就保留它；它只在處理 `didOpen` 時移除沒有開啟檔案的 project，之後 30 秒沒有編輯才清快取，Go 再把記憶體還給系統。一個 session 的 subagent 在 19 小時內輪流進出 4 個 worktree、編輯 41 個檔案，tsgo 就同時載入 4 份 project（各約 1.3–1.5 GB live heap），加上診斷批次重疊與 Go 的 2 倍 heap 目標，長到 49 GB footprint。設計如下：

- **單位是 git root**（repo 或 worktree）。不同 worktree 是彼此獨立的程式碼副本，關掉一個不會改變另一個的診斷或 references；同一個 repo 內的 tsconfig project 可能互相 import，所以不拆開。不在 git 裡的檔案共用一格。
- **依閒置時間釋放，不設數量上限。** 某個 workspace 超過 `idle_minutes` 沒被編輯或查詢（bridge 自己拉診斷不算），就把它的文件送 `didClose` 並「停放」（保留全文與版本）。由閒置檢查計時器處理（每 `idle_minutes`/4、最多 30 秒一次）：停放後開關一份 `untitled:` 文件，因為 tsgo 只在處理 `didOpen` 時移除沒有開啟文件的 project（實測不會動到還有開啟文件的 project）。
  - 曾經用「最多 2 個 workspace」的數量上限：4 個 worktree 同時編輯時，每次修改都觸發淘汰與重新載入，footprint 峰值反而比全部保留高（10.2 vs 8.0 GB），36 次修改有 29 次 30 秒內收不到錯誤。所以改成時間。實際紀錄（7 天、13 個 session、24 個 worktree）：任何 10 分鐘內，單一 session 只在 1 個 worktree 編輯，整台機器最多 2 個。
- 停放的文件收到 `didChange`（全文或局部）、任何帶 `textDocument.uri` / `item.uri` 的請求，或同一個 workspace 有新檔案 `didOpen` 時，整個 workspace 的停放文件依原順序一起重新開啟（再套用修改），並重新拉診斷。
- 每份文件同一時間最多一個診斷 pull；pull 進行中又被修改就記下來，回來後再拉一次。這把進行中的請求限制在開啟文件數以內（事故時是 30 批 × 41 份重疊），不會因為某個請求卡住而擋住其他文件，也不會在連續編輯時餓死。仍然檢查所有開啟的文件：不同 git root 也可能透過 submodule、`file:` 套件或 symlink 的 node_modules 互相影響。
- 同時真正在編輯的 worktree 都會保留：這個大型 Next.js 專案每個約 2 GB footprint。要讓大量 subagent 同時改很多 worktree，應改用一次性的型別檢查（例如 `tsc --noEmit`），不要每個都掛常駐 LSP。

## 4. 平台差異檢查表
| 項目 | Windows | macOS | Linux |
|---|---|---|---|
| 原生套件 | `typescript-win32-x64/arm64` | `darwin-arm64/x64` | `linux-x64/arm64/arm` |
| 執行檔名 | `tsc.exe` | `tsc` | `tsc` |
| 結束 process | TerminateProcess | SIGTERM → SIGKILL | 同 macOS |
| 路徑 / URI | 磁碟代號、`%3A`、大小寫不敏感 → 只用 Node 的 URL API | 大小寫不敏感（APFS 預設） | 大小寫敏感 |
| Orca 設定位置 | `%APPDATA%\orca` | `~/Library/Application Support/orca` | `~/.config/orca` |
| npm 位置 | `<node 目錄>\node_modules\npm` | `<prefix>/lib/node_modules/npm` | 同 macOS |
| CI | windows-latest | macos-latest（arm64） | ubuntu-latest |

## 5. 測試策略
1. **單元測試**：JSON-RPC 框架（含封包被切開、多位元組 UTF-8）、`offsetAt` 和局部修改、去重、狀態機轉換。
2. **整合測試**（真的跑 tsgo，三個平台都在 CI 跑）：
   - LSP：initialize 改寫、`initialized` 只送一次、didOpen / didChange（全文 + 局部）→ 推送、去重、閒置停止 → 重啟 → 重送、當機重試、shutdown。
   - MCP：`tools/list`、`ts_diagnostics` 對 fixture、檔案變動後重新檢查、LRU 關檔、多個 root。
3. **協定錄製回歸**：把 E3 錄下的 Claude Code initialize 和訊息順序存成 fixture 來重播；Claude Code 升級後重新錄一次並比對差異。
4. **手動驗收**（每個平台一次）：Claude 互動模式編輯 → 看到「Found N new diagnostic issues」；Codex 改完檔案後有呼叫 `ts_diagnostics`。

## 6. 實作階段
| 階段 | 內容 | 驗收 |
|---|---|---|
| P1 | 核心 + LSP 前端（把原型 v2 整理成模組）+ 單元和整合測試 | Windows 本機測試通過 |
| P2 | Claude plugin（`launch.mjs`、marketplace）+ `setup` / `doctor` / `uninstall` 的 Claude 部分 | 在這台機器的 Orca profile 裝起來，watsons 實測 |
| P3 | MCP 前端 + Codex skill + setup 的 Codex 部分 | Codex 實測 `ts_diagnostics` |
| P4 | CI matrix（Win / macOS / Linux）+ README + 版本發布 | 三個平台的 CI 都通過；在 Mac 上用一行指令裝好 |

## 7. 風險
| 風險 | 對策 |
|---|---|
| Codex plugin 的 MCP 機制改變或不穩定 | 只依賴 `codex mcp add`（穩定的官方指令）；之後 plugin 的 MCP 確認可用再加上這條路 |
| Claude Code 改變 LSP client 行為 | 協定錄製回歸測試；`doctor` 偵測 |
| 上游修好 push（TS PR #63921）或 Claude 支援 pull（#101041） | pull→push 做成可以關掉（`TSGO_PULL_TO_PUSH=0`），閒置停止仍然保留 |
| 第一次啟動要等 npm install | `setup` 先裝好；`startupTimeout` 120 秒 |
| 公司網路不能連 npm | 支援 `TSGO_TSC` 指向本機執行檔；`setup --offline <tarball>` |
| TS 7 比 TS 6 嚴格 | README 註明；屬於可以接受的差異 |

## 8. 本次新增的實驗（補充 v1 的 E1–E6）
- **E7 Codex plugin 裡的 MCP**：在暫時的 marketplace 放一個 probe plugin（`${CLAUDE_PLUGIN_ROOT}`、`${PLUGIN_ROOT}`、相對路徑三種寫法）。`codex plugin add` 成功，`codex mcp list` 也列得出來（顯示的是沒代換的字串），但 `codex exec` 的 session **完全沒有啟動**這 3 個 server。→ Codex 改用 `codex mcp add`。測試用的 marketplace 已經移除。
- **E8 直接啟動原生執行檔**：從 `@typescript/typescript-win32-x64/package.json` 推出 `lib/tsc.exe`，`--version` 回傳 7.0.2。→ 可以省掉 node 啟動器那一層。
- **E9 環境變數**：Claude 會給 LSP process `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_PROJECT_DIR`、`CLAUDE_CONFIG_DIR`（這台機器指向 Orca profile）。Codex 的 `CODEX_HOME` 也指向 Orca 帳號目錄。→ setup 一定要處理多個設定目錄。
- **E10 Codex skill 目錄**：`$CODEX_HOME/skills`、`~/.codex/skills`、`~/.agents/skills` 都存在。
