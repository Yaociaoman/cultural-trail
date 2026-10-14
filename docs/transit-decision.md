# TDX 運輸資料檢查（Phase 0）

> 整理日期：2026-10-14。規格見 `docs/carbon-route-prompt.md` §5。
> 狀態：**已決定（2026-10-14）**：採 TDX 模式，在 GitHub Actions 執行；缺檔時自動退回 MVP 模式。

## 現況

- 金鑰在 GitHub Secrets 的名稱：`TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`。
- 取得 token：`POST https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token`（client_credentials）。重試與 `retry-after` 處理在 `scripts/fetch-tdx.mjs`（目前整份註解保留）。
- 2026-10-14 起 workflow 已停用 TDX，改用 data.gov.tw（`scripts/fetch-opendata.mjs`，免金鑰）。
- 本機沒有 TDX 金鑰（`agent/.env` 只有 Agent 設定；shell 環境變數也沒有）→ **無法實測權限**。
- 專案根目錄沒有 `.gitignore`，`.env` 只被 `agent/.gitignore` 擋住；若要在根目錄放 `.env` 測試，需先補根目錄 `.gitignore`。

## 選項

1. **MVP 模式**（不靠站點資料）：捷運不顯示；公車／臺鐵／高鐵依距離範圍顯示並標「需確認站點」。
2. **TDX 模式**：使用者提供本機金鑰後實測；需改 workflow（加回金鑰）。
3. **改用 data.gov.tw 的車站資料集**（免金鑰，與目前地圖資料做法一致）：例如臺鐵、高鐵車站經緯度。仍需逐一確認資料集與授權。

## 決定

- 使用者確認：GitHub Secrets 中的同一組 TDX 金鑰，調整權限後即可取得運輸資料，不需要申請新的 API。
- 本機不實測。Phase 3 直接撰寫 `scripts/build-transit-data.js`，在 GitHub Actions 中執行；若抓不到（401／403），由使用者到 TDX 開通權限。
- 前端一律支援 MVP 模式；`data/transit_*.json` 不存在時自動退回。
- 捷運：即使有站點資料，因官方無碳排係數，**維持不顯示**。

## 實作（Phase 3，2026-10-14）

- API 路徑依 TDX 官方 swagger（`/webapi/serviceCategory/ForSwagger` 列出的「公共運輸-軌道」v2／v3、「公共運輸-公車」v2）：
  - 臺鐵 `/v3/Rail/TRA/Station`、高鐵 `/v2/Rail/THSR/Station`
  - 捷運 `/v2/Rail/Metro/Station/{RailSystem}`（TRTC、KRTC、TYMC、KLRT、NTDLRT、TMRT、NTMC、NTALRT；不含貓空纜車 TRTCMG）
  - 公車 `/v2/Bus/Stop/City/{City}`（22 縣市）、`/v2/Bus/Stop/InterCity`
- 不帶金鑰時閘道對任何路徑都回 401，無法在本機分辨路徑對錯；第一次在 GitHub Actions 執行後請看 log。
- 腳本：`scripts/build-transit-data.mjs`；測試：`node --test scripts/build-transit-data.test.mjs`。
- 前端：`carbon/transit.js`；兩種模式都套用 `carbon-config.json` 的距離範圍，TDX 模式另外要求兩端都在車站可達距離內，且最近的不是同一站。
- 捷運雖有站點資料，因官方無碳排係數仍不顯示。
