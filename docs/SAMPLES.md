# 訓練樣本 CSV

本頁適用於鍵盤、攝影機與 Tobii 三種來源。三者使用同一份欄位表；不適用的欄位留空。

啟動 EXE 時會在 EXE 所在資料夾建立 `Data` 資料夾。每局從按下開始起，在 `Data` 建立一個 UTF-8 BOM CSV，包含校正、遊戲及暫停期間收到的姿態結果。結束、回主選單與關閉視窗時完成儲存。瀏覽器預覽則於結束時下載 CSV。

每次姿態推論結果佔一列，包括未偵測到臉、無效數值、過期及重複結果。已積壓而未送入推論的舊視訊影格不是姿態樣本。碰撞另加一列 `event=collision`，引用最近頭部樣本的 sequence，保留碰撞當下的牛羊位置。鍵盤遊玩會記錄畫面樣本，`valid=false`、原因為 `keyboard-no-head-pose`。Tobii 的列與攝影機不同，見下方〈Tobii 頭部與視線列〉。

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
| game_mode | 本局練習模式：`timed` 固定時間、`endless` 無限加速 |
| run_time_s、speed_multiplier | 場景快照當時的飛行秒數與速度倍率（相對原始基準速度） |
| dodged_count、hit_count | 場景快照當時已閃過的羊數與碰撞次數；固定時間模式碰撞後會繼續，無限加速模式碰撞即結束 |
| head_directions | 該列寫入時頭控正在啟動的方向，例如 `left`、`up+right`；沒有方向時留空 |

VideoFrame 的媒體時鐘以攝影機影片時間對齊前端 monotonic 時鐘；不同媒體 epoch 會於第一幀建立偏移。這是軟體時間同步，不是硬體觸發同步。`scene_at_ms` 保留實際快照時間，未將舊場景偽裝為精確同時量測。

Rust 在背景執行緒每 200ms 接收 CSV 批次，依序寫入並 flush；正常結束再 sync_data。寫入失敗會顯示原因並暫停訓練，未寫入批次保留於記憶體。非正常斷電或強制終止仍可能損失最後尚未交付的批次。

## Tobii 頭部與視線列

Tobii 場次把 Stream Engine 送出的每一筆樣本各寫一列，頭部與視線列共用同一組遞增的 `sequence`。原生端以佇列保存樣本（上限 20,000 筆），前端每 16 ms 取回全部；佇列滿時捨棄最舊的一筆並計數，數量寫入 `tobii_dropped_samples` 與場次摘要。

| event | 內容 |
| --- | --- |
| `tobii-head` | 一筆 head pose。yaw／pitch／roll 各軸有效性分開判定，無效軸留空；`head_x/y/z` 為 Tobii 追蹤器座標（mm，`position_space=tobii-mm`） |
| `tobii-gaze` | 同一裝置時間戳的視線點與左右眼位置合併為一列，並與當時畫面上的十字比較 |
| `collision` | 碰撞事件；`sequence` 與 `device_timestamp_us` 指向當時用於控制的那一筆 `tobii-head` 列，牛羊位置為碰撞當下 |

兩種串流各有自己的裝置時間戳（ET5 實測約 33 Hz，頭部與視線相差數毫秒），因此頭部列與視線列不會落在同一列；需要時以 `captured_at_ms` 或 `device_timestamp_us` 對齊。`timestamp_source=tobii-device` 表示 `captured_at_ms` 由 SDK 樣本時間換算，而非前端收到的時間。

| 欄位 | 定義 |
| --- | --- |
| device_timestamp_us | SDK 原始裝置時間戳（微秒），頭部與視線列都有 |
| gaze_valid、gaze_x_norm、gaze_y_norm | Tobii 視線點是否有效，及其在 Tobii 設定螢幕上的正規化座標（左上 0,0、右下 1,1；可能超出 0–1） |
| gaze_x_px、gaze_y_px | 視線換算成遊戲視窗內的 CSS 像素座標，與 `target_x/y_px` 相同座標系 |
| left/right_eye_valid、left/right_eye_x/y/z_mm | 該眼位置是否有效及其在 Tobii 追蹤器座標中的位置（mm）；無效時座標留空 |
| target_visible、target_x_px、target_y_px | 十字是否在畫面上，及其中心位置。遊戲中為畫面中央的白色十字；校正階段為校正圓圈中央的十字 |
| gaze_error_px、gaze_error_mm、gaze_error_deg | 視線與十字中心的距離：視窗像素、螢幕上的 mm，以及從雙眼中點看去的視角 |
| gaze_on_target | `gaze_error_deg` 不超過容許角度時為 true；無法計算視角時留空，不當作未注視 |
| fixation_tolerance_deg | 本場設定的注視容許角度（預設 3°） |
| tobii_dropped_samples | 到該列為止，原生佇列因溢位捨棄的累計筆數；正常應為 0 |

視角以雙眼位置的中點為頂點計算，只有一眼有效時用該眼。同一筆兩眼位置都無效時，沿用 1 秒內最近一次有效的位置；超過 1 秒則 `gaze_error_deg` 與 `gaze_on_target` 留空。螢幕實體尺寸來自 Tobii Experience 的螢幕設定（display area）；拿不到時只記錄像素偏差，不做注視判定。

視線換算假設遊戲視窗位於 Tobii 設定的那台螢幕上。校正畫面會顯示螢幕比例檢查；比例不符時，像素與角度欄仍會寫入，但不可直接採信，場次摘要的 `display.check.matches` 也會是 false。

## 場次摘要 JSON

每局 CSV 完成時，同一資料夾另寫 `<CSV 檔名>_session.json`。欄位：

| 欄位 | 內容 |
| --- | --- |
| schemaVersion、appVersion、csvFile | 摘要格式版本、程式版本、對應的 CSV 檔名 |
| startedAt、endedAt、endReason | 開始／結束時間（ISO 8601），結束原因：`time-up`、`collision`、`menu`、`restart`、`window-closed`、`keyboard-fallback` |
| source、practice、sheepDirections | 操作來源、練習設定（模式、起始速度、單次分鐘數、每分鐘加速百分比）、啟用的羊方向 |
| headThresholdsDeg、neutralBaseline | 四方向門檻與中立點；鍵盤場次為 null |
| result | 飛行秒數、閃過數、碰撞數、結束時的速度倍率 |
| fixation | 僅 Tobii：容許角度、視線樣本數、可判定比例、注視比例、轉頭期間注視比例、平均偏差角度。只統計遊戲進行中（`state=play`）的視線列，不含校正、倒數與暫停 |
| tobii | 僅 Tobii：裝置型號、韌體、輸出頻率、display area、可用串流，以及捨棄樣本數 |
| display | 僅 Tobii：遊戲視窗與所在螢幕的位置、尺寸、縮放，以及螢幕比例檢查結果 |

## 限制

不儲存攝影機影像、錄影或完整臉部特徵點。攝影機與鍵盤場次沒有眼動量測。Tobii 場次記錄的是 Tobii 的視線估計與頭部姿態，可用於確認受試者是否注視十字；精度取決於 Tobii Experience 的校準與螢幕設定，並非醫療等級的量測。VOR gain 等指標須由研究者自行依頭部與眼動資料計算，本程式不直接輸出。
