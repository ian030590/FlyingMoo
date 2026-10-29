# FlyingMoo (飛天牛 · 閃避飛天羊)

[![Build Windows portable](https://github.com/ian030590/FlyingMoo/actions/workflows/windows-portable.yml/badge.svg)](https://github.com/ian030590/FlyingMoo/actions/workflows/windows-portable.yml)

[下載 Windows x64 可攜版](https://github.com/ian030590/FlyingMoo/releases/latest)。下載 `.exe` 後即可執行，無須安裝。圖片與音效的來源及授權記載於 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

[開啟網頁／PWA](https://ian030590.github.io/FlyingMoo/)。首次連線完成離線資源下載後，可安裝至電腦或手機主畫面並離線使用。攝影機追蹤保留 MediaPipe；網頁的 Tobii 需在 Windows 執行本機橋接程式。安裝、離線與橋接步驟見 [網頁與 PWA 使用說明](docs/PWA.md)。

FlyingMoo 是使用 Tauri 2、Rust 與 WebView2 製作的 VOR 視覺復健教具，可用鍵盤、Tobii Eye Tracker 5 或攝影機頭部追蹤操作。攝影機使用隨程式附帶的 MediaPipe Face Landmarker 模型，在本機執行。

Tobii 支援 Windows 桌面版，網頁／PWA 則透過 Windows 本機橋接使用。先安裝 Tobii Experience 與官方驅動、接上 ET5 並完成官方校準，再於主選單選擇「Tobii Eye Tracker 5」及「開始遊戲」，依序完成遊戲中立點與四方向校正。接口動態使用官方安裝目錄內的 Stream Engine 4.x，不隨 EXE 散布 SDK DLL；缺少元件時顯示錯誤，鍵盤與攝影機仍可使用。Tobii 場次會把每筆頭部姿態與視線樣本（螢幕注視點、左右眼位置）寫入 CSV；遊戲須放在裝有 ET5 的螢幕上，網頁版需點擊「全螢幕」才能判定是否注視中央十字。接口及時間戳定義見 [Tobii 接口](docs/TOBII.md)。

攝影機預覽出現即表示已取得相機存取。首次啟用後仍需載入辨識模型；畫面會分別顯示模型載入、等待臉部與姿態採集。中立點從第一筆有效姿態開始計時，至少收集 2 秒及 30 筆穩定樣本；更新較慢時會繼續採集，不會在兩秒時直接判定失敗。

遊戲畫布最高以 1080 像素高度繪製，降低高 DPI 螢幕的負載，讓攝影機辨識有足夠運算時間；介面文字仍使用螢幕原有解析度。

---

## 遊戲特色

1. **三種操作來源**：
   - **鍵盤**：保留原生 WASD 與方向鍵飛行操作。
   - **攝影機 (Webcam)**：使用本機 Web Worker 與 MediaPipe Face Landmarker 逐幀取得頭部朝向；實際更新率依裝置效能而定。
   - **Tobii Eye Tracker 5**：透過本機官方 Stream Engine 取得真實頭部旋轉與位置，同時記錄視線與眼睛位置；使用相同的中立校正、方向判定與失效暫停流程。
2. **完整校正與方向判定**：
   - 2 秒中立點校正採集（標準差 ≤ 2.0° 防抖驗證）。
   - 四方向驗證（抬頭、低頭、左轉、右轉各維持 500ms 後回正）。
   - 上、下、左、右各有獨立門檻；以 One Euro Filter 自適應濾波與遲滯防抖減少抖動，方向判定不再額外等待確認。
   - 牛中央與校正圓圈中央均有白色凝視十字；校正圓圈固定在視窗正中央，綠框四側對應四方向門檻。
   - 設定中的方向按鈕可分別開關四個方向的羊隻；全部關閉時可只練習頭部動作。
3. **練習模式與速度**：
   - **固定時間**：羊以固定速度飛來，時間到即結束；碰撞會計次，但不中斷練習。單次時間 1–30 分鐘。
   - **無限加速**：從起始速度開始，每分鐘依設定比例加速且沒有上限，碰撞即結束。
   - 起始速度 0.5–3 倍可調，設定畫面會換算羊從出現到抵達牛所需秒數。
4. **VOR 注視檢查（Tobii）**：
   - 以眼睛到螢幕的距離換算視線與中央十字的視角偏差，在容許範圍（預設 3°，1–10° 可調）內即視為注視十字。
   - 遊戲中 HUD 顯示注視比例，結果畫面另列轉頭期間的注視比例與平均偏差；可開啟視線點，讓實驗者即時觀察。
5. **安全邊界與按軸接管**：
   - 任何一方鍵盤按下時自動接管該軸控制，放開後交還頭控。
   - 每筆姿態抵達時會檢查採集時間，超過 250ms 的結果不使用；超過 250ms 沒收到有效新姿態時，清空方向並暫停。接收間隔另行計時，避免推論耗時造成誤判中斷。
   - 視窗失焦、最小化時自動暫停，遊戲進程與障礙物完全凍結。
6. **離線執行與隱私安全**：
   - 所有 MediaPipe WASM 及 `face_landmarker.task` 模型隨程式本機內嵌，無任何遠端傳輸或雲端遙測。
   - 不錄影、不保存臉部影像或完整臉部特徵點。每局自動保存頭部姿態、牛羊位置、碰撞及樣本有效性至本機 CSV；Tobii 場次另存視線、眼睛位置與注視十字的判定。

啟動 EXE 時會在 EXE 所在資料夾建立 `Data` 資料夾。CSV 由 Rust 在背景批次寫入 `Data`，結束、回主選單或關閉視窗時完成儲存，並在旁邊寫入同名的 `_session.json` 場次摘要（練習設定、成績、注視統計、裝置與螢幕資訊）；結果畫面會顯示實際路徑。欄位、座標與有效性的定義見 [樣本紀錄說明](docs/SAMPLES.md)。

支援直接視訊影格串流的 WebView2 會將攝影機影格送入既有推論執行緒，只處理最新影格；不支援時沿用單一影格的備援路徑。相機請求、推論模型、遊戲解析度與視覺效果維持原設定。

MediaPipe 優先使用 GPU；初始化或推論失敗時自動改用 CPU。直接串流時，原始 `VideoFrame` 直接送入模型，省去中間的 `ImageBitmap` 轉換。One Euro Filter 取代原有 EMA，依採集時間計算濾波；慢動作較穩定，快動作時提高截止頻率以減少跟隨延遲。原始姿態與濾波後角度分開記錄，CSV 的 `inference_delegate` 顯示該筆使用 GPU 或 CPU。

GPU 首次推論需要暖機，過期結果不參與校正；本機測試首次約 4 秒，之後推論中位數約 17 ms。完整條件、SDK 比較、濾波參數與驗證限制見 [頭控驗證紀錄](docs/HEAD_TRACKING.md)。

牛與翅膀的三層光暈以目前畫布解析度快取，視窗尺寸改變時重建，避免每幀重新處理濾鏡；圖片、光暈與翅膀動畫都保留。

---

## 系統需求

- **作業系統**：Windows 11 x64（主要驗收平台）或 Windows 10 x64
- **必要元件**：Microsoft Edge WebView2 Runtime（Windows 10/11 系統多已內建）
- **頭部追蹤裝置**（選用）：
  - 支援 640×480 @ 30fps 之內建或外接 USB 攝影機
  - Tobii Eye Tracker 5（需安裝 Tobii Experience 並完成螢幕設定與校準）

---

## 控制方式一覽

| 動作 | 鍵盤按鍵 | 頭部控制姿勢 | 遊戲反應 |
| :--- | :--- | :--- | :--- |
| **向上飛** | `↑` 或 `W` | 向上抬頭 (Pitch > 0) | 牛向上翱翔 |
| **向下飛** | `↓` 或 `S` | 向下低頭 (Pitch < 0) | 牛向下俯衝 |
| **向左飛** | `←` 或 `A` | 向左轉頭 (Yaw < 0) | 牛向左側轉向 |
| **向右飛** | `→` 或 `D` | 向右轉頭 (Yaw > 0) | 牛向右側轉向 |
| **回到中央** | 放開方向鍵 | 頭部回到校正時的中立坐姿 | 該軸以原移動速度回到可動平面中央 |
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
    head-control.mjs            中立校正、自適應濾波、遲滯與方向判定
    one-euro-filter.mjs         One Euro Filter（時間單位毫秒、角度單位度）
    desktop.mjs                 Tauri 原生命令與單調時鐘同步
    session-recorder.mjs        場次 CSV 欄位、批次寫入與場次摘要
    gaze-target.mjs             視線換算為視窗座標、視角偏差與注視統計
    providers/
      webcam.mjs                相機設備排程與 Worker 通訊
      pose-worker.mjs           MediaPipe Face Landmarker 離線推論 Worker
      tobii.mjs                 Tobii 快照輪詢、時鐘映射與狀態處理
    vendor/mediapipe/           本機離線 MediaPipe JS/WASM
    models/face_landmarker.task 本機臉部特徵點模型
  src-tauri/
    tauri.conf.json             Tauri 2 桌面應用程式配置
    Cargo.toml                  Rust 宿主依賴
    build.rs                    Tauri build 腳本
    capabilities/main.json      視窗權限能力
    src/main.rs                 原生視窗、WebView2 相機權限與 IPC
    src/tobii.rs                Stream Engine 動態載入、頭部／視線串流與樣本佇列
    src/recording.rs            CSV 背景寫入與場次摘要 JSON
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
產物將輸出至 `dist/FlyingMoo_<version>_x64-portable.exe`，版本取自 `src-tauri/tauri.conf.json`，並附帶 `SHA256SUMS.txt`、`README.md`、`LICENSE` 及 `THIRD_PARTY_NOTICES.md`。歷次更新內容各自保存於 [release notes](docs/releases/)。
