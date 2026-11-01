# tsgo-bridge

讓 **Claude Code** 和 **Codex** 改用 **TypeScript 7 原生語言伺服器（tsgo）**，提供型別檢查與程式碼導覽。Windows、macOS、Linux 都能用。

| | 原本（tsserver 6） | tsgo-bridge |
|---|---|---|
| 記憶體（monorepo 開 8 個套件） | 約 3.9 GB | 約 1.9 GB |
| 閒置 10 分鐘後 | 照樣佔著 | **約 0 MB**（自動停止，下次用到再啟動，約 1 秒） |
| 編輯後型別錯誤 | 1.5–8 秒 | 0.1–2.4 秒 |
| Codex | 沒有 | `ts_diagnostics` 等 MCP 工具 + skill |

它帶來的好處：
- **Agent 看得到自己造成的型別錯誤。** 編輯後的下一步就會收到錯誤，可以先修正再繼續。
- **用語意找程式碼。** 用 definition / references 取代文字搜尋，不會被同名但意思不同的字誤導。
- **省記憶體。** tsgo 大約只用 tsserver 一半的記憶體；每個 session 都會各開一個 server，所以 session 越多省越多。
- **閒置自動停止。** 閒置 10 分鐘就停掉 tsgo（約 1 GB → 58 MB），下次用到約 1 秒內重啟。
- **一次裝好兩邊。** 一個 `setup` 指令同時裝好 Claude Code plugin 和 Codex MCP，Windows、macOS、Linux 都能用。
- **不動你的專案。** 只替 agent 用一份私有的 TypeScript 7，專案 build 照樣用專案自己的 TypeScript 版本。
- **可以完整還原。** `uninstall` 會移除 tsgo-bridge，並重新啟用 setup 停用的 plugin。

以上數字是在一台 Windows 電腦上測的，實際結果可能不同。

## 為什麼需要它

tsgo-bridge 是**暫時性的橋接**。之所以需要它，是因為 tsgo 目前沒辦法直接和這些 agent 搭配使用：

1. **tsgo 不會主動推送診斷結果。** TS 7 的語言伺服器只在 client 主動要求時（pull，`textDocument/diagnostic`）才回傳單一檔案的診斷，不會送出 `textDocument/publishDiagnostics`（push）。
2. **Claude Code 只接受推送的診斷結果。** 它不會主動跟伺服器要診斷，所以 tsgo 直接接上 Claude Code 的話，編輯後完全看不到型別錯誤。
3. **Codex 沒有 LSP client。** 它無法直接使用語言伺服器，只能用 MCP。

相關 issue 與 PR（2026-11-01 的狀態）：

| 項目 | 內容 | 狀態 |
|---|---|---|
| [microsoft/TypeScript#63928](https://github.com/microsoft/TypeScript/issues/63928) | 讓 tsgo 對不支援 pull 的 client 推送診斷 | Open，標籤「Needs Investigation」 |
| [microsoft/TypeScript#63921](https://github.com/microsoft/TypeScript/pull/63921) | 實作推送的 PR | Open、未 merge、等待 review；2026-08-20 之後沒有更新 |
| [anthropics/claude-code#101041](https://github.com/anthropics/claude-code/issues/101041) | 讓 Claude Code 主動 pull 診斷 | Open，標籤「enhancement」 |

另外還繞過了 tsgo 的兩個問題：不轉送 client 的第二次 `initialized`（tsgo 收到兩次會出錯停止），也不告訴 tsgo client 會監看檔案（讓 tsgo 自己監看）。

**什麼時候可以拿掉：** 只要 tsgo 支援推送診斷，或 Claude Code 支援 pull，就可以拿掉 Claude Code 這部分。拿掉前先設 `TSGO_PULL_TO_PUSH=0`，確認 Claude Code 還是看得到型別錯誤；這時 tsgo-bridge 只負責轉送訊息和閒置停止。等 Codex 有了 LSP client，Codex 這部分也可以拿掉。

## 運作方式

- **Claude Code**：plugin（`tsgo-lsp`）註冊一個 LSP server。
  - Claude Code 只接收主動推送的診斷結果，TS 7 卻只提供 pull 模式（[TypeScript#63928](https://github.com/microsoft/TypeScript/issues/63928)、[claude-code#101041](https://github.com/anthropics/claude-code/issues/101041)）。tsgo-bridge 會在每次開啟或編輯檔案後，代替 Claude 去 pull，再推送給它。
  - 閒置太久就停掉 tsgo，下次有請求時再重啟，並把已開啟的檔案重新送給 tsgo。
- **Codex**：Codex 沒有 LSP client，所以改成註冊 MCP server `tsgo`，提供 `ts_diagnostics`、`ts_definition`、`ts_references`、`ts_hover`、`ts_symbols`。另外安裝 skill `tsgo-typecheck`，告訴 Codex 改完 TS 檔要做型別檢查。
- TypeScript 7 會依作業系統和 CPU 架構，由 npm 安裝對應的原生執行檔；tsgo-bridge 直接啟動這個執行檔。

## 安裝

需求：Node.js ≥ 20（含 npm）、git，以及 Claude Code 或 Codex CLI（有哪個裝哪個）。


```bash
# 預覽會做哪些事（不會修改任何設定）
npx -y github:treuwok/tsgo-bridge setup --dry-run

# 安裝到目前的 Claude Code / Codex 設定
npx -y github:treuwok/tsgo-bridge setup

# 安裝到所有找到的設定目錄（預設的 ~/.claude、~/.codex，加上每一個 Orca profile）
npx -y github:treuwok/tsgo-bridge setup --all-homes
```

`setup` 會做的事：
1. 安裝 TypeScript 7 的原生執行檔，並確認它能在這台機器上執行。
2. Claude Code：
   - `claude plugin marketplace add treuwok/tsgo-bridge`
   - `claude plugin install tsgo-lsp@tsgo-bridge`
   - 找出**所有**也替 `.ts/.tsx/.js/...` 註冊 LSP 的已啟用 plugin，例如官方的 `typescript-lsp`、vtsls，或第三方的多語言 `lsp-servers`。Claude Code 會把同一個副檔名交給**最先註冊**的 plugin，所以只要這些 plugin 還開著，tsgo-lsp 就不會被使用。
     - 只提供 TS/JS 的 plugin：自動停用。
     - 也提供其他語言的 plugin（例如 Python、Go）：預設**不會**停用，setup 會標示 `CONFLICT` 並列出停用後會失去哪些語言。確認要停用的話，加 `--disable-conflicting` 重跑一次。
     - 停用前的狀態都會記下來，`uninstall` 時還原。
   - 啟用與停用是直接寫進該設定目錄的 `settings.json`，因為多個 Orca profile 共用同一個 plugins 目錄時，`claude plugin enable/disable` 會寫錯檔案。
3. Codex：
   - 把 runtime 複製到使用者的資料目錄。
   - `codex mcp add tsgo -- node <runtime>/bin/tsgo-bridge.mjs mcp`
   - 複製 skill 到 `$CODEX_HOME/skills/tsgo-typecheck`。

裝完後**開一個新的 session** 才會生效。

### 驗證

```bash
npx -y github:treuwok/tsgo-bridge doctor
```

會檢查 Node 版本和原生執行檔，跑一次 LSP 與 MCP 的端對端自我測試，並列出每個設定目錄的安裝狀態。

在 Claude Code 裡故意寫一個型別錯誤，畫面上應該出現 `Found N new diagnostic issues`。

### 常用選項

| 選項 | 說明 |
|---|---|
| `--dry-run` | 只列出會做的事 |
| `-y` | 不要詢問確認 |
| `--all-homes` / `--home <dir>` | 選擇要安裝的設定目錄 |
| `--claude-only` / `--codex-only` | 只裝其中一邊 |
| `--idle-minutes <n>` | Codex 的閒置停止時間（預設 10，0 = 不停止） |
| `--disable-conflicting` | 連同也提供其他語言、但會搶走 `.ts/.js` 的 LSP plugin 一起停用 |
| `--source <owner/repo \| git url \| 本機路徑>` | Claude marketplace 的來源（測試用） |

Claude 的閒置停止時間是 plugin 的設定（`idle_minutes`），可以在 `/plugin` 或 `claude plugin configure tsgo-lsp@tsgo-bridge` 修改。

## 更新

```bash
claude plugin marketplace update tsgo-bridge && claude plugin update tsgo-lsp@tsgo-bridge
npx -y github:treuwok/tsgo-bridge setup --codex-only   # Codex：安裝新的 runtime，並更新 MCP 路徑
```

## 移除

```bash
npx -y github:treuwok/tsgo-bridge uninstall
```

會移除 plugin 和 marketplace，重新啟用原本開著的官方 `typescript-lsp`，並移除 Codex 的 MCP 和 skill。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `TSGO_IDLE_MS` / `TSGO_IDLE_MINUTES` | 10 分鐘 | 閒置停止時間；0 = 不停止 |
| `TSGO_BRIDGE_LOG` | 無 | 寫 log 到這個檔案（5 MB 輪替） |
| `TSGO_TSC` | 內建 | 指定其他 tsgo / tsc 執行檔 |
| `TSGO_DIAG_DEBOUNCE_MS` | 50 | 合併連續編輯的時間 |
| `TSGO_PULL_TO_PUSH` | 1 | 上游支援 push 或 pull 之後，可以設成 0 關掉轉換 |
| `TSGO_BRIDGE_DATA` | 依作業系統 | runtime 和狀態檔的位置 |

資料目錄：Windows `%LOCALAPPDATA%\tsgo-bridge`、macOS `~/Library/Application Support/tsgo-bridge`、Linux `~/.local/share/tsgo-bridge`。

## 已知限制

- TypeScript 7 比 5/6 更嚴格，可能回報專案自己的 build 不會報的錯誤。
- tsconfig 裡的 TS plugin（例如 Next.js 的 `{ "name": "next" }`）不會載入。Vue、Svelte、Astro 範本也不支援。
- 閒置停止後的第一個請求要多等約 1 秒。

## 開發

```bash
npm install
npm test                      # 單元測試 + 對真實 tsgo 的 LSP/MCP 整合測試
node bin/tsgo-bridge.mjs doctor
claude --plugin-dir .         # 只在這個 session 載入 plugin，用來測試
```

設計與實驗紀錄：見 `docs/`。
