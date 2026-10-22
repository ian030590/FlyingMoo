# 頭控推論與濾波驗證（2026-10-22）

程式原本已使用 [Google MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)。這次保留 SDK 0.10.20 與原有模型，改為 GPU 優先；初始化或推論失敗時重建 CPU 推論器。直接串流使用原始 VideoFrame，省去 ImageBitmap 轉換；備援影格路徑維持可用。

## 同模型推論比較

在本機 WebView2，以同一張人像產生 640×480 VideoFrame。每組先暖機 10 幀，再量測 35 幀；numFaces=1、VIDEO 模式、輸出轉換矩陣，不輸出 blendshapes。

| SDK | 後端／輸入 | 推論中位數 | P95 |
| --- | --- | --- | --- |
| 0.10.20 | CPU／ImageBitmap（修改前） | 28.4 ms | 33.0 ms |
| 0.10.20 | GPU／VideoFrame（修改後） | 16.1 ms | 17.7 ms |
| 1.1.1 | CPU／VideoFrame | 27.7 ms | 32.3 ms |
| 1.1.1 | GPU／VideoFrame | 16.3 ms | 18.0 ms |

每組 35 筆均偵測成功。新版 SDK 在這組測試沒有明顯更快，因此沒有升級套件。相機請求、輸入尺寸、模型、遊戲畫布與素材都未降低品質。

實際新版 EXE 的 30 Hz 人像串流完成中立校正，暖機後推論中位數 17.0 ms、P95 20.9 ms，軟體採集時間到姿態送達中位數 17.1 ms。第一幀 GPU 推論耗時約 3.9 秒；該筆過期資料會排除，校正從後續有效結果開始。

## One Euro Filter

依 [casiez/OneEuroFilter 的 JavaScript 實作](https://github.com/casiez/OneEuroFilter/blob/main/javascript/OneEuroFilter.js) 改寫為毫秒時鐘介面，取代原有 20 ms EMA。yaw、pitch 各自濾波，minCutoff=3 Hz、beta=2、derivativeCutoff=1 Hz；輸入角度單位為度，依實際採集間隔計算。置中、暫停與訊號失效時清除角度及速度歷史，保留方向遲滯與四方向閾值。

30 Hz 合成角度測試：

| 指標 | 20 ms EMA | One Euro Filter |
| --- | --- | --- |
| 靜止抖動 RMS | 0.379° | 0.301°（降低約 21%） |
| 18°、1.5 Hz 往返動作追蹤誤差 RMS | 0.913° | 0.315°（降低約 65%） |

在 20、30、60 Hz 的這些測試訊號上，靜止抖動與快速動作誤差均比原本 EMA 小。這是指定測試訊號的結果，手感仍需真人確認。

新版 EXE 的頭控測試另以 30 Hz、14° 階躍、固定 40 ms 姿態傳遞時間量測牛開始移動，各做三次：第一輪原本 EMA 中位數 83.2 ms，One Euro Filter 49.8 ms；正式 Release 重建後複測為 116.1 ms 與 83.0 ms。兩輪均約減少一個 30 Hz 影格（33 ms），絕對值會受採集與繪圖時序影響。這是合成輸入到遊戲反應的測試，不能視為實體攝影機到畫面的完整延遲。

## 回歸驗證

- 63 項 Node 測試通過，包含變動採樣間隔、方向切換、重設、GPU 初始化失敗及推論失敗的 CPU 備援。
- 新版 EXE 通過四方向閾值、羊隻選擇、凝視十字、無效樣本暫停、回正恢復、碰撞紀錄與視窗關閉存檔；頁面錯誤 0。
- 正式 Release EXE 複測：242 筆訓練紀錄與關閉前 84 筆紀錄保存成功；人像串流推論中位數 17.3 ms、P95 21.4 ms。
- 遊戲畫布維持 1767×1080；姿態輸入維持 640×480。模型 SHA-256：`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`。
- CSV 仍寫入 EXE 同層的 Data；新增 inference_delegate 欄位，原始姿態與濾波角度分開保存。測試 CSV 已移除。

以上使用本機 WebView2、人像測試圖與合成姿態，尚未測試真人及實體攝影機。不同 GPU 的速度與暖機時間可能不同；One Euro Filter 改善的是控制訊號，無法縮短模型本身的推論時間。
