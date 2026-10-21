# FlyingMoo (飛天牛 · 閃避飛天羊)

[![Build Windows portable](https://github.com/ian030590/FlyingMoo/actions/workflows/windows-portable.yml/badge.svg)](https://github.com/ian030590/FlyingMoo/actions/workflows/windows-portable.yml)

[下載 Windows x64 可攜版](https://github.com/ian030590/FlyingMoo/releases/latest)。下載 `.exe` 後即可執行，無須安裝。圖片與音效的來源及授權記載於 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

FlyingMoo 是使用 Tauri 2、Rust 與 WebView2 製作的 Windows 桌面遊戲，可用鍵盤或攝影機頭部追蹤操作。攝影機使用隨程式附帶的 MediaPipe Face Landmarker 模型，在本機執行。

此版本尚未支援 Tobii Eye Tracker 5。介面會停用該選項，原生介面也會回報未支援。攝影機方向判定與校正有合成姿態回歸測試，實際追蹤效果仍需依裝置、光線與坐姿確認。

---

## 遊戲特色

1. **兩種操作來源**：
   - **鍵盤**：保留原生 WASD 與方向鍵飛行操作。
   - **攝影機 (Webcam)**：使用本機 Web Worker 與 MediaPipe Face Landmarker 逐幀取得頭部朝向；實際更新率依裝置效能而定。
2. **完整校正與方向判定**：
   - 2 秒中立點校正採集（標準差 ≤ 2.0° 防抖驗證）。
   - 四方向驗證（抬頭、低頭、左轉、右轉各維持 500ms 後回正）。
   - 具備遲滯防抖（啟動門檻與釋放門檻分離）與 50ms 候選確認。
3. **安全邊界與按軸接管**：
   - 任何一方鍵盤按下時自動接管該軸控制，放開後交還頭控。
   - 追蹤訊號中斷或樣本超過 250ms 未更新時立即清空方向並暫停，避免卡鍵。
   - 視窗失焦、最小化時自動暫停，遊戲進程與障礙物完全凍結。
4. **離線執行與隱私安全**：
   - 所有 MediaPipe WASM 及 `face_landmarker.task` 模型隨程式本機內嵌，無任何遠端傳輸或雲端遙測。
   - 不保存、不記錄玩家面部影像或生物特徵數據。

---

## 系統需求

- **作業系統**：Windows 11 x64（主要驗收平台）或 Windows 10 x64
- **必要元件**：Microsoft Edge WebView2 Runtime（Windows 10/11 系統多已內建）
- **頭部追蹤裝置**（選用）：
  - 支援 640×480 @ 30fps 之內建或外接 USB 攝影機

---

## 控制方式一覽

| 動作 | 鍵盤按鍵 | 頭部控制姿勢 | 遊戲反應 |
| :--- | :--- | :--- | :--- |
| **向上飛** | `↑` 或 `W` | 向上抬頭 (Pitch > 0) | 牛向上翱翔 |
| **向下飛** | `↓` 或 `S` | 向下低頭 (Pitch < 0) | 牛向下俯衝 |
| **向左飛** | `←` 或 `A` | 向左轉頭 (Yaw < 0) | 牛向左側轉向 |
| **向右飛** | `→` 或 `D` | 向右轉頭 (Yaw > 0) | 牛向右側轉向 |
| **中立停止** | 放開方向鍵 | 頭部回到中央中立坐姿 | 該軸停止移動 |
| **重新置中** | `R` 鍵 | 點擊「置中 (R)」按鈕 | 重新以當前角度為中立點 |
| **暫停遊戲** | `Esc` 鍵 | 點擊「暫停」按鈕 | 清空輸入並凍結遊戲畫面 |
| **靜音切換** | `M` 鍵 | 點擊「音效」按鈕 | 開啟／關閉風聲與程序音效 |
| **開始／繼續** | `Space` 鍵 | 點擊「開始」按鈕 | 進入 3 秒倒數後起飛 |

---

## 專案結構

```text
FlyingMoo/
  PRD.md                        產品需求規格書
  TRD.md                        技術架構規格書
  flying-cow.html               原始單一 HTML 參考基線
  package.json                  專案依賴與腳本設定
  THIRD_PARTY_NOTICES.md        第三方軟體與授權聲明
  LICENSE                       專案授權
  scripts/
    prepare-assets.cjs          MediaPipe WASM 與模型離線資產準備腳本
    package-portable.cjs        可攜式單一 EXE 打包與 SHA-256 校驗腳本
  wwwroot/
    index.html                  遊戲與 UI 畫面 (符合 strict CSP)
    styles.css                  復古像素街機風格與無障礙樣式
    app.mjs                     狀態機協調與生命週期管理
    game.mjs                    固定 60Hz 步進遊戲核心與程序音效
    input.mjs                   鍵盤仲裁與按軸接管管理器
    head-control.mjs            中立校正、EMA 濾波、遲滯與方向判定
    desktop.mjs                 Tauri 原生命令與單調時鐘同步
    providers/
      webcam.mjs                相機設備排程與 Worker 通訊
      pose-worker.mjs           MediaPipe Face Landmarker 離線推論 Worker
      tobii.mjs                 Tobii 介面預留，本版未啟用
    vendor/mediapipe/           本機離線 MediaPipe JS/WASM
    models/face_landmarker.task 本機臉部特徵點模型
  src-tauri/
    tauri.conf.json             Tauri 2 桌面應用程式配置
    Cargo.toml                  Rust 宿主依賴
    build.rs                    Tauri build 腳本
    capabilities/main.json      視窗權限能力
    src/main.rs                 原生視窗、WebView2 相機權限與 IPC
    src/tobii.rs                單調時鐘與 Tobii 未支援回應
    native/tgi_bridge.h         TGI C ABI 橋接標頭檔
    native/tgi_bridge.cpp       TGI 介面預留，未串接官方 SDK
  tests/
    input.test.mjs              輸入仲裁、按鍵別名與軸接管單元測試
    head-control.test.mjs       方向判定、門檻遲滯與中立校正測試
    game.test.mjs               固定 60Hz 累加步進與邊界測試
    fixtures/synthetic-poses.json 合成姿態回歸測試資料
```

---

## 建置與測試指南

### 1. 安裝相依套件與準備離線資產
```bash
npm ci
npm run prepare-assets
```
此步驟會複製 `@mediapipe/tasks-vision` 的 WASM 檔案並驗證 `face_landmarker.task` 模型的 SHA-256 完整性。

### 2. 執行自動化測試
本專案使用 Node 內建 test runner，測試輸入、校正、遊戲步進與畫面流程：
```bash
npm test
```

### 3. 開發模式預覽
```bash
npm run dev
```

### 4. 建置 Windows 可攜式免安裝 EXE
```bash
npm run build
```
產物將輸出至 `dist/FlyingMoo_1.0.1_x64-portable.exe`，並附帶 `SHA256SUMS.txt`、`README.md`、`LICENSE` 及 `THIRD_PARTY_NOTICES.md`。
