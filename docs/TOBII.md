# Tobii Eye Tracker 5 接口

Windows x64 桌面版從 `%ProgramW6432%\Tobii\Tobii EyeX\tobii_stream_engine.dll` 載入已安裝的官方元件；未設定 ProgramW6432 時使用 ProgramFiles。只接受 Stream Engine 4.x，不從目前目錄或 PATH 搜尋 DLL，也不內嵌或重散布 SDK。開發機實測版本為 4.25.0.3，C ABI 與 head pose（48 bytes）、gaze point（24 bytes）、gaze origin（40 bytes）、display area（36 bytes）及 device info（2048 bytes）結構已對照該安裝中的官方 .NET wrapper。

使用前先在 Tobii Experience 完成螢幕設定與校準，並把遊戲視窗放在裝有 ET5 的螢幕上。主選單選擇 Tobii，開始後完成遊戲的中立點與四方向校正。一般瀏覽器停用此來源。

## 原生指令

| 指令 | 輸入 | 結果 |
| --- | --- | --- |
| `get_native_clock` | 無 | 程式啟動後的單調時間 `timestampUs` |
| `start_tobii` | `sessionId`，非零 u32 | 啟動背景執行緒，立即回傳 `starting` 快照；連線結果透過後續快照提供 |
| `read_tobii_snapshot` | `sessionId` | 該 session 的最新快照，加上自上次讀取後佇列中的全部樣本 `samples` 與累計溢位數 `droppedSamples`；其他或已停止的 session 回傳無效、`stopped` |
| `read_tobii_device` | `sessionId` | 裝置型號、韌體、序號、輸出頻率、display area 與可用串流；未連線時為 null |
| `get_window_geometry` | 無 | 遊戲視窗內容區與所在螢幕的實體像素位置、尺寸與縮放，用於把視線換算到視窗 |
| `stop_tobii` | `sessionId` | 僅停止相符 session；0 用於關閉全部串流 |

`start_tobii`、`read_tobii_snapshot`、`read_tobii_device`、`stop_tobii` 僅接受主視窗。前端將啟停指令依序執行；SDK 的載入、裝置操作、回呼與釋放都由同一條背景執行緒完成。換來源或關閉程式時先取消訂閱，再釋放裝置、API 與 DLL。

## 快照

| 欄位 | 定義 |
| --- | --- |
| `sessionId`、`valid` | 所屬 session、三軸旋轉是否有效 |
| `timestampUs` | SDK 樣本時間換算為原生單調時鐘的微秒值；重讀不修改 |
| `yawDeg` | 向玩家自己右轉為正；SDK Y 軸弧度取負後轉為度 |
| `pitchDeg` | 抬頭為正；SDK X 軸弧度轉為度 |
| `rollDeg` | SDK Z 軸弧度轉為度 |
| `headX`、`headY`、`headZ` | SDK 原始位置座標，mm；位置無效時皆為 null，與旋轉有效性分開判定 |
| `status` | `starting`、`connected`、`tracking-lost`、`error`、`stopped`，有效姿態可為 null |
| `code`、`message` | 可辨識的錯誤碼及說明，沒有錯誤時可為 null |

啟動時以 `tobii_system_clock` 對照原生時鐘，使用呼叫前後中點建立偏移；每 5 秒執行裝置時鐘同步。回呼只接受遞增的來源時間戳，不用角度是否變化判斷新樣本。讀取時拒用超過 250 ms 或來自未來的快照。前端再經五輪最低 RTT 時鐘同步，映射至 `performance.now()`，拒絕重複、舊 session、無效角度與過期資料。

原生回呼約每 5 ms 處理一次，前端每 16 ms 最多一個讀取在途；兩者皆不是感測器輸出頻率宣稱。控制只使用最新姿態；紀錄則另由樣本佇列取得每一筆，見下節。姿態失效或訊號過期時清空控制並暫停；恢復後仍須置中及明確繼續。裝置斷線或 SDK 錯誤會停止該串流，重新連接後按「重試 Tobii」。

## 視線與樣本佇列

連線後除 head pose 外，裝置支援時另訂閱 gaze point 與 gaze origin。三者皆為選用符號，缺少或不支援時只記錄頭部，校正畫面會說明原因。

| 串流 | 內容 |
| --- | --- |
| head pose | 三軸旋轉（各軸有效性分開）與頭部位置 mm |
| gaze point | 視線落點，正規化至 Tobii 設定的螢幕（左上 0,0） |
| gaze origin | 左右眼在追蹤器座標中的位置 mm，用來計算眼睛到螢幕的距離與視角 |

同一幀的 gaze point 與 gaze origin 共用裝置時間戳，原生端合併為一筆 `gaze` 樣本；頭部為 `head` 樣本。兩部分可能在不同次 `process_callbacks` 抵達，因此收齊才寫出；下一幀開始、等待超過 100 ms 或串流停止時，未收齊的一幀也會寫出。樣本推入佇列，上限 20,000 筆（約 5 分鐘不讀取的量）；滿時捨棄最舊一筆並累計 `droppedSamples`。前端每次讀取取走全部樣本，映射至前端時間後逐筆寫入 CSV，即使該次讀取同時回報追蹤失效也不略過。

裝置資訊在串流連線後讀取一次。display area 為 Tobii Experience 螢幕設定的三個角（mm），前端依此把視線換算成視窗像素，並以視窗所在螢幕的長寬比與 display area 比對，相差超過 3% 時提示視線可能不準。

## 注視十字判定

遊戲中的目標是畫面中央的白色十字，校正時為校正圓圈中央的十字。每筆視線換算到 display area 平面後，以雙眼中點為頂點，計算視線點與十字中心的夾角；不超過容許角度（預設 3°，設定中 1–10° 可調）即判定為注視。場次的注視比例只統計遊戲進行中的視線樣本，並另計頭控正在轉向時的比例，供 VOR 練習檢查。可在設定開啟視線點，讓實驗者在畫面上即時看到視線位置。

## 部署與紀錄

缺少官方元件、未接裝置、未提供 head pose、元件版本不相容或存取被拒絕時顯示各別錯誤；不影響鍵盤與攝影機。沒有自動安裝驅動或下載 SDK。

Tobii 以 `STORE_OR_TRANSFER_TRUE` 模式連線，表示樣本會寫入本機檔案。Tobii 場次與攝影機、鍵盤相同，每局在 `Data` 寫一份 CSV 與 `_session.json` 摘要；欄位見 [樣本紀錄說明](SAMPLES.md)。

Tobii 消費級產品（含 ET5）的授權條款將「儲存或傳輸眼動資料」列為分析用途，需另向 Tobii 取得分析用授權。SDK 在本機接受此模式，不代表已具備授權；用於研究前請先確認授權狀態。

原先 TRD §7 的 TGI/C++ bridge 為規劃路徑；目前接口依本機官方元件的能力與實機驗證，直接採 Stream Engine C ABI。舊的 `native/tgi_bridge.*` 未納入建置。

## 驗證紀錄（v1.2.0，2026-10-22）

- `npm test`：85 項通過，包括視線換算（視窗位移、第二螢幕、DPI 縮放）、視角與注視判定、無效樣本、注視統計、Tobii 樣本轉發、CSV 欄位、場次摘要與練習模式。
- `cargo test --release`：8 項通過，包括 gaze point／gaze origin／display area／device info 的 ABI 大小、同一幀跨 process 週期合併、佇列溢位計數與場次摘要寫檔。
- 封裝 EXE（版本 1.2.0）連接實機 ET5（`IS5_Large_Eyetracker_5`，韌體 02a1a6a977，Stream Engine 4.25.0.3），約 27 秒的場次（校正 7 秒、倒數 4 秒、遊戲 15 秒）：
  - 寫出 876 列 `tobii-head`（864 列旋轉與位置有效）及 876 列 `tobii-gaze`（473 列視線有效），兩者裝置時間間隔中位數 30.2 ms（約 33 Hz），時間戳與 `sequence` 皆嚴格遞增。
  - 0 筆溢位；樣本採集至前端接收的時間差中位數 22 ms。
  - 3 列碰撞的 `sequence` 都對應到實際的 `tobii-head` 列。
  - `_session.json` 與 CSV 同名，含裝置資訊、`STORE_OR_TRANSFER_TRUE`、display area 285×190 mm。螢幕比例檢查與 2880×1920 內建螢幕相符。
  - 校正畫面與遊戲中十字皆位於視窗中心（640, 391.6 CSS px），兩者座標一致。
- 前一輪實機測試發現同一幀的視線被拆成兩列（1 組），修正後重測為 0。
- 連續啟停 20 次、舊 session 隔離通過；Tobii 已改為會記錄的場次。獨立程序模擬缺少 DLL 仍顯示 `TOBII_RUNTIME_UNAVAILABLE`，鍵盤可遊玩。

以下為合成或強制條件，不等同完整實機驗收：

- 進入遊戲是由測試程式設定中立點並啟動倒數，未由受試者完成四方向校正；測試期間忽略視窗失焦造成的暫停。頭部與視線資料仍為實機資料。
- 上述注視比例（57%）與平均偏差，來自當時坐在 ET5 前、未受指示的使用者，不是受控的注視準確度測試。視角計算的正確性目前以合成幾何測試確認。
- 固定時間模式在實機只跑 15 秒；時間到結束、無限加速與速度上限移除由單元測試覆蓋。

尚未驗收：受試者依指示注視十字並轉頭的受控測試、3° 容許角度是否適合研究用途、長時間場次（30 分鐘）、USB 拔插，以及多螢幕配置。
