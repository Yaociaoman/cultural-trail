# Taiwan Cultural Trails（臺灣文化旅程足跡）— 專案規則

> Claude Code 啟動時會自動讀取這個檔案。

## 專案是什麼
互動式觀光網站（網頁版）：整合 TDX 官方開放資料（景點、餐廳、文創活動），旅客到現場拍照，以照片 EXIF GPS 驗證後集章；搭配 SDGs 小卡、徽章與「永續文化通行證」。競賽作品，兩人協作。

## 協作方式
- 兩位組員**各自開分支**，不直接推 `main`，開工前先合併最新的 `main`。
- **A**：`backend/`（登入、資料庫、集章與 EXIF 驗證、點數與兌換），以及登入、集章的前端串接。
- **B**：`agent/`（Python + FastAPI + Ollama 的 Agent AI 導覽）、碳排與路線、多語言（繁中／English／日本語／Deutsch）、聊天前端串接。
- **只改你負責的範圍。** 需要動到對方範圍時，先停下來告訴使用者。

## 通用規則
- `data/locations.json` 由 GitHub Actions 每週自動覆蓋，**唯讀，不要手動修改**。
- 金鑰、`.env`、`.venv/`、模型檔**不可 commit**。API 金鑰不可寫進前端程式碼。
- **不要重寫整個 `index.html` 或整個 AI Guide 分頁**；沿用現有介面（例如 `getReply(text)` 回傳 `{ reply, chips }`）。
- 機器人回覆**不可用 `innerHTML` 顯示未消毒的內容**（避免 XSS）。
- 使用者的電腦是 Mac（zsh）。Python 一律用虛擬環境，不要裝到系統 Python。
- 對話與註解以繁體中文為主，變數與函式用英文。
- 有不確定的地方先問使用者，不要自己猜。每完成一個階段就停下來說明改了什麼、怎麼驗證。

## 做 Agent AI（B）時
**先完整讀 `docs/agent-spec.md`**，依其中的 Phase 順序進行，每個 Phase 驗收後再做下一個。從 Phase 0（環境確認，不寫程式）開始。
