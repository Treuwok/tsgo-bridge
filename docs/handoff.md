# Project Handoff

> Last updated: 2026-11-10
> Updated by: Session: 收尾閒置 worktree 釋放（#1 已 merge）
> 現在在做: 無進行中的工作 — 後續項目 #2、#3、#4 待辦

## 待辦（Pending）

- [ ] **[2026-11-10]** LSP：對從沒開過的檔案直接發請求時，tsgo 會在 bridge 不知情下載入該 project
  - 背景：要先確認 Claude Code 呼叫 LSP 工具前會不會先送 didOpen，前提還沒錄到
  - Issue/PR：#2（open）
  - 下一步：用 `TSGO_BRIDGE_LOG` 錄一次真實 session 的 LSP 工具呼叫｜前提成立才修｜從 `src/tsgo-manager.mjs` 的 `request()` 開始
- [ ] **[2026-11-10]** MCP：每個 git root 各一個 tsgo，總數沒有上限
  - 背景：#1 刻意讓 MCP 行為不變；還沒有實際使用頻率的資料
  - Issue/PR：#3（open）
  - 下一步：先量 Codex 使用時同時存在幾個 MCP tsgo｜決定要不要做閒置釋放｜從 `src/mcp-server.mjs` 的 `workspace()` 開始
- [ ] **[2026-11-10]** tsgo 永遠不回應某個請求時，閒置停止會被擋住
  - 背景：改版前就存在；#1 之後卡住只影響那份文件，但閒置停止仍不會發生
  - Issue/PR：#4（open）
  - 下一步：用 `test/fake-tsgo.mjs` 的 `FAKE_DIAG_HANG` 先寫測試｜再為請求加上限時間｜從 `TsgoManager.#checkIdle` 開始

## 進行中（In Progress）

## 已完成（Completed）

- [x] **[2026-11-10]** 閒置 worktree 釋放（tsgo 49 GB 記憶體事故）— PR #5 merge、版本 0.1.3；使用者要更新插件並重啟 session 才會生效

## 備註（Notes）

- 不要加回 worktree 數量上限，也不要改用 tsconfig 當單位、不要改回「批次 + 取消」：實測理由在 `docs/tsgo-bridge-design.md` §3.4 與 `docs/codereview/lsp-bounded-working-set/review-result.md`。
- bridge 內部關檔一律走 `#close`（不呼叫 `touch()`），否則閒置停止會被延後到約 2 倍時間。
