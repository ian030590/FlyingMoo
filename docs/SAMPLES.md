# 訓練樣本 CSV

啟動 EXE 時會在 EXE 所在資料夾建立 `Data` 資料夾。每局從按下開始起，在 `Data` 建立一個 UTF-8 BOM CSV，包含校正、遊戲及暫停期間收到的姿態結果。結束、回主選單與關閉視窗時完成儲存。瀏覽器預覽則於結束時下載 CSV。

每次姿態推論結果佔一列，包括未偵測到臉、無效數值、過期及重複結果。已積壓而未送入推論的舊視訊影格不是姿態樣本。碰撞另加一列 `event=collision`，引用最近頭部樣本的 sequence，保留碰撞當下的牛羊位置。鍵盤遊玩會記錄畫面樣本，`valid=false`、原因為 `keyboard-no-head-pose`。

| 欄位 | 定義 |
| --- | --- |
| sample_index、event、source、state、sequence | 本檔列序、事件、來源、應用狀態與姿態序號 |
| captured_at_ms、received_at_ms | 同一前端 monotonic 時間基準的影格採集與姿態接收時間 |
| unix_time_ms | `performance.timeOrigin + captured_at_ms`，用於跨檔對應時間 |
| inference_started_at_ms、inference_finished_at_ms | 已換算至前端時間基準的推論開始／結束時間 |
| video_timestamp_us、timestamp_source | 原始視訊時間戳及來源；直接影格路徑為 video-frame，備援為 video-element |
| yaw_deg、pitch_deg、roll_deg | 頭部角度，單位度；yaw 正值為向自己右轉，pitch 正值為抬頭 |
| head_x、head_y、head_z、position_space | 臉部轉換矩陣的平移座標，face-model；無矩陣時為鼻尖 normalized-landmark 座標。兩種座標空間不可直接混用，也不是已校正的實際頭部位移 |
| delta_yaw_deg、delta_pitch_deg | 相對本次中立姿態的偏差 |
| filtered_yaw_deg、filtered_pitch_deg | 當時 mapper 的 One Euro Filter 狀態；校正階段尚未進入遊戲濾波 |
| inference_delegate | 該筆推論使用 GPU 或 CPU；非 webcam 樣本留空 |
| scene_at_ms、scene_valid | 場景快照時間；選取採集時間前最近一幀，差距不超過 100ms 才為 true。無可對齊快照時保留接收當下場景並設為 false；碰撞列使用事件當下場景 |
| cow_x、cow_y、cow_z | 牛的遊戲平面座標與前進位置；x、y 的可動範圍為 -0.42 至 0.42，z 為遊戲世界單位 |
| sheep_positions_json | 該快照的所有羊，JSON 陣列。每隻包含 id、direction、x、y、z、relativeZ、alive、passed |
| collision、collided_sheep_id | 是否為碰撞事件及碰撞羊隻 ID；此處 collision 對應使用者所稱 collapse |
| valid、invalid_reason | 姿態是否通過來源、序號、數值及 250ms 新鮮度檢查；不代表醫療量測效度。無效原因例如 no-face、stale、duplicate-or-out-of-order |
| frame_width、frame_height | 實際送入推論的原始影格尺寸 |
| left/right/up/down_threshold_deg | 該列當時生效的四方向啟動門檻 |

VideoFrame 的媒體時鐘以攝影機影片時間對齊前端 monotonic 時鐘；不同媒體 epoch 會於第一幀建立偏移。這是軟體時間同步，不是硬體觸發同步。`scene_at_ms` 保留實際快照時間，未將舊場景偽裝為精確同時量測。

Rust 在背景執行緒每 200ms 接收 CSV 批次，依序寫入並 flush；正常結束再 sync_data。寫入失敗會顯示原因並暫停訓練，未寫入批次保留於記憶體。非正常斷電或強制終止仍可能損失最後尚未交付的批次。

不儲存攝影機影像、錄影、完整臉部特徵點或眼球／視線資料。這份資料記錄頭部控制與遊戲事件，沒有眼動量測，不能單憑它計算 VOR gain。
