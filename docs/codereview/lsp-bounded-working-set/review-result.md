# Code Review Report - lsp-bounded-working-set（#1）

**Primary host**: claude（Claude 側等價 harness：第 1 輪 8 個 angle；第 2 輪 2 個 angle，針對最終驗證）
**Cross-review host**: codex
**Cross-review reviewer**: gpt-5.6-sol · effort=medium（第 1、2、3 輪的輸出 header 都相符）
**Cross-review receipt**: 4 份 `codex review` 原始輸出（header 是 `model: gpt-5.6-sol` / `reasoning effort: medium`，結尾是 `___CODEX_EXIT_0___`）。這些輸出含有本機路徑，所以沒有放進 repo

> 驗證方式說明：第 1 輪的 8 個 finder 中，有 6 個用真實 tsgo 7.0.2 或 HEAD 對照實驗**自行重現**了它們的候選問題；第 2 輪的 2 個 finder 重現了 14 則中的 13 則。已重現的候選不再另派 verifier；其餘的由我逐則判讀，結果寫在下表。這與 harness「每則各派一個獨立 verifier」的規格不同，在此如實記錄。

## 這次改動要解決的問題

Claude Code 從不送 `didClose`，所以 agent 編輯過的每個 TS 檔都會一直開在 tsgo 裡。只要某個 project 還有開啟的檔案，tsgo 就會保留它。在一個 session 裡，subagent 在 4 個 git worktree 編輯了 41 個檔案，tsgo 因此同時載入 4 份 project（每份約 1.3–1.5 GB live heap）。再加上診斷批次重疊（30 批 × 41 個請求）和 Go 的 2 倍 heap 目標，footprint 長到 49 GB。

## 最終設計（第 4 輪改版後）

- **閒置的 workspace 釋放，不設數量上限**：一個 git root（repo 或 worktree）超過 `idle_minutes`（預設 10 分鐘，`TSGO_IDLE_MS`）沒被編輯或查詢，就停放它的文件（保留全文與版本），然後開關一份 `untitled:` 文件，觸發 tsgo 移除那個 project。bridge 自己拉診斷不算「使用」。正在使用的 workspace 一律保留。這個機制只用在 LSP 端；MCP 不使用。
- **停放文件的重新開啟**：遇到以下任一情況，整個 workspace 的停放文件會依原順序重新開啟，然後重新拉診斷：
  - 收到 `didChange`（全文或局部）；
  - 收到帶 `textDocument.uri` 或 `item.uri` 的請求；
  - 同一個 workspace 有新檔案 `didOpen`。
- **「使用」由前端決定**：
  - LSP：didChange 和請求算。
  - MCP：工具呼叫算，`resyncOpen` 不算。MCP 保留原本每個 manager 50 份文件的 LRU，現在由 manager 統一處理。
- **每份文件同一時間最多一個診斷 pull**，pull 結束後再補拉。仍然檢查所有開啟的文件，跟 HEAD 一樣。
- **manager 生命週期修正**：
  - `idleMs = 0` 時不會被閒置停止。workspace 釋放的計時器導入之後，這一點需要明確檢查。
  - tsgo 正在停止時收到文件變動，停止之後會重新啟動。
  - manager 關閉後，`request()` 會立刻回錯誤。

## 各輪 finding 與處置

### 第 1 輪（Claude 8 angle ＋ Codex）：打在原始改動上，修正後整體重新設計

| # | 來源 | 問題 | 處置 |
|---|---|---|---|
| 1 | Codex P1、D | 被淘汰的文件收到局部 didChange 時，從硬碟讀檔，沒有套用修改 | 修：manager 停放全文，重新開啟後再套用修改。proxy 的 `reopen` 刪除 |
| 2 | Codex P1 | 測試依賴 `Removed watch` 這行 log，在沒有檔案監看的環境會失敗 | 修：改用 `Deleting configured project` 這行與監看無關的 log |
| 3 | Altitude、A、C（真實 tsgo 重現） | hover、definition 等請求打在被淘汰的文件上，tsgo 會在背後重新載入 project，上限失效 | 修：`request()` 遇到停放文件時，先把它的 workspace 開回來 |
| 4 | Altitude、Efficiency、D、Reuse | workspace 單位：不在 git 裡的檔案每個資料夾各算一區；開頭是 `..` 的資料夾名稱被誤判；沒有處理大小寫 | 修：不在 git 裡的檔案共用一格；改用共用的 `norm`；拿掉 fallbackRoot 的邏輯 |
| 5 | Altitude、B | LSP 新增的 50 份文件上限，讓同一個 project 的文件收不到跨檔錯誤 | 修：LSP 不設文件數上限；MCP 明確傳 50 |
| 6 | Altitude、A、D、B、C | 單批次：卡住的請求讓之後的診斷全部停住；可能推送過時結果；有未處理的例外 | 第 2 輪改成「每份文件一個 pull」後一併解決 |
| 7 | D、Reuse、Simplification | 環境變數是空白、負數、小數時，變成不限制 | 修：`intEnv` 只接受非負整數，其他一律用預設值 |
| 8 | D、A、Altitude、Efficiency、B | MCP 不讀 `TSGO_MAX_WORKSPACES`，卻被套上 2 個 workspace 的上限 | 修：MCP 不套 workspace 上限，跟 HEAD 一致；文件註明這個設定只影響 Claude Code |
| 9 | C、B | MCP 的 resync 被算成「有在用」 | 修：recency 改由前端呼叫 `markUsed` |
| 10 | Simplification | `#makeRoom` 是 O(n²)，而且有 4 份副本；env 解析難讀；`touchDoc` 和 `touch` 名字太像 | 修：改成單次掃描；改名 `markUsed` |
| 11 | B（真實 tsgo 重現） | 用 tsconfig 當單位時，會漏掉跨 project 的 references | 不改用 tsconfig 當單位，維持 git root（理由見設計說明） |

### 第 2 輪（Claude 2 angle ＋ Codex）：主要打在第 1 輪新增的取消批次機制上，改為移除該機制

| # | 來源 | 問題 | 處置 |
|---|---|---|---|
| 12 | 兩個 angle 都重現 | 取消批次後，被取消那一批的範圍沒有放回待辦，其他 workspace 一直停在舊結果 | 移除批次與取消機制，改成每份文件一個 pull |
| 13 | 行為回歸（真實 tsgo 重現） | 只拉「被改動的 git root」，會漏掉 submodule、`file:` 套件、symlink 的 node_modules、途中才 `git init` 的情況 | 恢復 HEAD 的「拉所有開啟文件」 |
| 14 | 行為回歸 | 改得比一批檢查還快時，一直取消就一直推送不出去（HEAD 推送 7 次，新版 0 次） | 同 #12 |
| 15 | 兩邊 ＋ Codex P2 | 放棄的請求一直留在 pending，idle stop 失效；放棄的結果晚到還會覆蓋新的結果 | 同 #12：沒有放棄機制了。卡住的請求只影響那一份文件（跟 HEAD 一樣，見〈不修〉R-N3） |
| 16 | 行為回歸 | 文件在 pull 途中被停放，結果被丟掉；因為請求而開回來的文件也沒有重新拉診斷 | 修：只要 client 那端還開著（`isOpen`）就推送；新增 `reopen` 事件，觸發 `schedule` |
| 17 | Line-by-line（真實 tsgo 重現） | 在停放的 workspace 新開檔案時，同 workspace 的停放文件沒有一起回來 | 修：`openDoc` 會把同 workspace 的停放文件一起開回來 |
| 18 | Line-by-line | 文件重新開回時順序顛倒 | 修：停放時保留原本順序 |
| 19 | Line-by-line | 重啟和 didSave 也會取消批次 | 同 #12：已經沒有取消機制 |
| 20 | 行為回歸 | `workspace/symbol` 搜尋不到停放中的 worktree | 文件化：README 的已知限制補上 |

### 第 3 輪（Codex）

| # | 來源 | 問題 | 處置 |
|---|---|---|---|
| 21 | Codex P2 | callHierarchy 的 incoming/outgoing 請求，URI 放在 `params.item.uri`，會繞過重新開回 | 修：新增共用的 `docUri()`，manager 和 proxy 都改用它。另加測試，修之前紅、修之後綠 |

**收斂判定**：第 2、3 輪的所有 finding 都打在前幾輪新增的機制上，沒有一則打在原始改動。依修法退場規則，第 3 輪修完後收尾，不再送審。

### 第 4 輪（使用者問「3、4 個 worktree 同時用會怎樣」觸發）：把數量上限改成依閒置時間釋放

| # | 來源 | 問題 | 處置 |
|---|---|---|---|
| 22 | 實測（4 個真實 worktree，40 次輪流編輯） | 用「最多 2 個 workspace」的數量上限時，同時使用的 worktree 互相淘汰：38 次重新載入；footprint 峰值 10.2 GB，比全部保留時的 8.0 GB 還高；錯誤推送中位數 15 秒；36 次修改有 29 次在 30 秒內收不到錯誤 | 改成依閒置時間釋放，拿掉 `max_workspaces`。改版後同一情境：0 次淘汰，中位數 0.16 秒，36/36 都收到錯誤 |
| 23 | 新測試（決定性重現） | tsgo 正在停止的那段時間收到文件變動，停止後不會重新啟動。這是舊版 manager 就有的時間窗：LSP 和 MCP 之後一定會發 pull 請求，所以實務上會自己恢復 | 修：用 `startAfterStop` 旗標記下來。另加測試：修之前 3/3 紅，修之後 3/3 綠 |
| 24 | 新測試 | 導入 workspace 計時器之後，`idleMs = 0` 的 manager 會被閒置停止 | 修：閒置停止前先檢查 `idleMs > 0`。漏掉這個檢查時有 3 個測試會紅 |
| 25 | Codex P2（第 4 輪） | 停放閒置 workspace 時呼叫 `closeDoc()`，會重設整個 server 的活動時間，tsgo 要到大約 2 倍的閒置時間才停止 | 修：內部關檔改用不記錄活動的 `#close`。另加測試：修之前要 2.26 秒才停，修之後 1.26 秒（設定是 1 秒加一次 250ms 檢查） |

**收斂判定**：第 2 到第 4 輪的所有 finding，都打在前幾輪新增的機制上。第 4 輪修完後收尾，不再送審。

### PR #5 第 1 輪（Codex 在 GitHub 上的自動審查）

| # | 來源 | 問題 | 處置 |
|---|---|---|---|
| 26 | Codex P2（`src/lsp-proxy.mjs:51`） | 一次診斷 pull 比閒置時間還長時，worktree 會在 pull 回來前被停放；期間那次修改的補拉被丟掉，最後的錯誤推不出去 | 修：停放判斷沿用整台閒置停止的規則，有請求還在跑的 worktree 不算閒置。上一輪為「pull 途中被停放」加的 `isOpen` 變成用不到，刪掉。另加測試（Codex 的重現步驟），修之前紅、修之後綠 |

使用者的實際使用紀錄（7 天、13 個 session、24 個 worktree）：任何 10 分鐘內，單一 session 只在 1 個 worktree 編輯；整台機器所有 session 合計最多 2 個。

## 不修（記錄）

### R-N1：請求打在「從沒開過」的檔案上，tsgo 會暫時載入它的 project，bridge 不知道它存在
**檔案**: `src/tsgo-manager.mjs`（`request`）
**誰會踩到**: agent 對另一個 worktree 裡一個從沒編輯過的檔案呼叫 LSP 工具，而且 Claude Code 沒有先送 didOpen
**多常發生**: 未查證。Claude Code 呼叫 LSP 工具前會不會先送 didOpen，沒有錄到
**踩到會怎樣**: 多出 1 份 project，直到下一次任何地方有 didOpen 時被 tsgo 移除，有上限、不會累積
**為什麼不修**: 「多常發生」填不出具體內容
**已開 issue**: #2

### R-N2：MCP 每個 git root 各開一個 tsgo，總數沒有上限
**檔案**: `src/mcp-server.mjs`（`workspace()`）
**誰會踩到**: Codex 在 10 分鐘內，對 3 個以上的 worktree 呼叫 `ts_diagnostics`
**多常發生**: 查到的狀況：這台機器上的 Codex MCP bridge 跑了 5 天，檢查時沒有任何 tsgo 子程序；沒有使用頻率的資料
**踩到會怎樣**: N 份 project，各自閒置 10 分鐘後停止
**為什麼不修**: 「多常發生」不具體，而且不是這次事故的路徑（行為跟 HEAD 相同）
**已開 issue**: #3

### R-N3：tsgo 永遠不回應某個請求時，idle stop 不會觸發（HEAD 就有）
**誰會踩到**: 遇到 tsgo 無窮迴圈 bug 的專案（typescript-go #4528、#4819 這類）
**多常發生**: 少見，上游 bug
**踩到會怎樣**: tsgo 一直不會被閒置停止
**為什麼不修**: 不是這次引入的；這次的改動也不會讓它更容易發生（卡住只影響那一份文件）
**已開 issue**: #4

### 其他不修（成本或影響都抽象）
- **MCP `ts_diagnostics` 一次超過 50 個檔案會反覆開關**：HEAD 的 MAX_OPEN 就是這樣。
- **`published` Map 會持續成長**：HEAD 就有，量級約 MB。
- **每次 openDoc 都同步往上找 `.git`**：tsgo 開檔時自己也做同樣的往上找，量測約 9µs。
- **測試 helper 在多個測試檔各有一份**：目前沒有共用的 helper 模組。
- **連續編輯時，可能先推送「落後一個版本」的結果，下一次 pull 會補正**：這是 HEAD 的語意。加版本檢查會造成餓死（#14），所以刻意維持。

## 驗證
- **`npm test`**：35/35 通過。
- **拿掉修法、確認變紅**：最終設計的 17 個部分逐一拿掉，對應的測試全部變紅；另外有 3 個修法的測試，修之前紅、修之後綠。
- **`node bin/tsgo-bridge.mjs doctor`**：LSP 和 MCP 自我檢查都通過。
- **實測一：4 個 worktree 同時輪流編輯**（同一個大型 Next.js monorepo 的 4 個真實 worktree；40 次修改）

| | 舊的數量上限 2 | 依閒置時間（預設 10 分鐘） |
|---|---|---|
| 重新載入次數 | 38 次 | 0 次 |
| footprint 峰值 | 10.2 GB | 8.4 GB |
| 錯誤推送延遲 | 中位數 15 秒 | 中位數 0.16 秒、p90 0.3 秒 |
| 收不到錯誤 | 29/36 | 0/36 |

- **實測二：worktree 一個做完換下一個**（每個 12 次修改；為了縮短實驗，閒置時間設 20 秒）

| | 永不釋放（等同舊版） | 依閒置時間 |
|---|---|---|
| 實際使用量（每換一個 worktree） | 1.6 → 2.9 → 4.7 → 5.4 GB | 1.3 → 2.2 → 2.8 → 2.8 GB |
| 最後一次修改後 65 秒 | footprint 7.3 GB，tsgo 不會停 | tsgo 已經停止，記憶體全部歸還 |

- **實測三：事故重演**（第 3 輪的設計，48 次編輯、4 個 worktree）：
  - 舊版：live 5.8–7.2 GB；閒置後 footprint 8.3 GB，而且還在往上。
  - 新版：live 2.8–3.6 GB。

## 通過項目
| 檢查項目 | 狀態 |
|---------|------|
| 惡意程式碼 | 無發現 |
| MCP 安全檢查（allowedRoots/absPath） | `gitRoot` 和 `norm` 的語意沒變，只是搬到共用模組 |
| 模組預算（check-module-budget.sh） | 全部 ok，沒有超標的檔案 |
| CLAUDE.md / AGENTS.md 慣例 | repo 和上層目錄都沒有 |
