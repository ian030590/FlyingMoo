# Tobii Eye Tracker 5 接口

Windows x64 桌面版從 `%ProgramW6432%\Tobii\Tobii EyeX\tobii_stream_engine.dll` 載入已安裝的官方元件；未設定 ProgramW6432 時使用 ProgramFiles。只接受 Stream Engine 4.x，不從目前目錄或 PATH 搜尋 DLL，也不內嵌或重散布 SDK。開發機實測版本為 4.25.0.3，C ABI 與 48 bytes 的 head pose 結構已對照該安裝中的官方 .NET wrapper。

使用前先完成 Tobii Experience 的裝置設定與校準。主選單選擇 Tobii，開始後完成遊戲的中立點與四方向校正。一般瀏覽器停用此來源。

## 原生指令

| 指令 | 輸入 | 結果 |
| --- | --- | --- |
| `get_native_clock` | 無 | 程式啟動後的單調時間 `timestampUs` |
| `start_tobii` | `sessionId`，非零 u32 | 啟動背景執行緒，立即回傳 `starting` 快照；連線結果透過後續快照提供 |
| `read_tobii_snapshot` | `sessionId` | 該 session 的最新快照；其他或已停止的 session 回傳無效、`stopped` |
| `stop_tobii` | `sessionId` | 僅停止相符 session；0 用於關閉全部串流 |

`start_tobii`、`read_tobii_snapshot`、`stop_tobii` 僅接受主視窗。前端將啟停指令依序執行；SDK 的載入、裝置操作、回呼與釋放都由同一條背景執行緒完成。換來源或關閉程式時先取消訂閱，再釋放裝置、API 與 DLL。

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

原生回呼約每 5 ms 處理一次，前端每 16 ms 最多一個讀取在途；兩者皆不是感測器輸出頻率宣稱。只保存最新姿態，不累積原始樣本佇列。姿態失效或訊號過期時清空控制並暫停；恢復後仍須置中及明確繼續。裝置斷線或 SDK 錯誤會停止該串流，重新連接後按「重試 Tobii」。

## 部署與紀錄

缺少官方元件、未接裝置、未提供 head pose、元件版本不相容或存取被拒絕時顯示各別錯誤；不影響鍵盤與攝影機。沒有自動安裝驅動或下載 SDK。

Tobii 以 `STORE_OR_TRANSFER_FALSE` 模式連線，只供即時控制。Tobii 場次不啟動 CSV，碰撞與姿態記錄入口也排除此來源。攝影機與鍵盤原有紀錄流程維持不變。

原先 TRD §7 的 TGI/C++ bridge 為規劃路徑；目前接口依本機官方元件的能力與實機驗證，直接採 Stream Engine C ABI。舊的 `native/tgi_bridge.*` 未納入建置。

## 驗證紀錄（2026-10-22）

- `npm test`：72 項通過，包括兩個頭部來源的合成中立校正／四方向驗證，以及 Tobii 過期、重複、舊 session、取消啟動與錯誤處理。
- `cargo test --release --manifest-path src-tauri/Cargo.toml`：4 項通過，包括原生 ABI、角度換算、時鐘映射與過期拒用。
- `npm run build`：Windows x64 可攜版建置通過。
- 封裝 EXE 的真實 ET5 → Rust → IPC → 前端路徑：收到 275 筆有效頭部旋轉與位置，完成中立點校正並進入四方向驗證；SDK 樣本時間至前端接收的時間差為 9.4–30.4 ms。Tobii CSV 未啟動。
- 連續啟停 20 次、舊 session 的停止／讀取隔離通過；測試後串流確實停止。
- 獨立程序模擬缺少 DLL：顯示 `TOBII_RUNTIME_UNAVAILABLE` 與安裝提示，仍可開始鍵盤遊戲，攝影機選項仍可選；無前端執行錯誤。

實機四方向動作、USB 拔插與長時間穩定性尚未驗收；四方向控制邏輯目前由合成姿態測試覆蓋。
