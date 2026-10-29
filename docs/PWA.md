# 網頁與 PWA

開啟 [FlyingMoo 網頁](https://ian030590.github.io/FlyingMoo/)。鍵盤與 MediaPipe 攝影機頭部追蹤可直接使用；Tobii 需要 Windows 本機橋接。攝影機影像在裝置內辨識，不會上傳至 GitHub。

## 安裝與離線

首次連線請等待主選單顯示「離線資源已備妥」，包含遊戲、圖片、音效、MediaPipe WASM 與模型。之後可使用「安裝飛天牛」或瀏覽器的安裝選單。iPhone／iPad 在 Safari 分享選單選「加入主畫面」。瀏覽器未提供安裝提示時，仍可直接使用網頁。

離線資源下載完成後，可關閉網路並重新開啟。攝影機仍需要授權與可用裝置。瀏覽器若清除網站資料、撤銷儲存或自動回收快取，需要再次連線下載。手機的操作以攝影機為主，沒有新增觸控方向鍵。

有新版時會先下載完整資源；請結束練習並關閉所有 FlyingMoo 網頁與 PWA 視窗，再開啟使用新版。遊戲中不會強制重新載入。

## Tobii 本機橋接

1. 使用 Windows 電腦，安裝 Tobii Experience 與官方驅動，連接 Eye Tracker 5 並完成官方校準。
2. 從 [最新下載](https://github.com/ian030590/FlyingMoo/releases/latest) 選擇名稱含 `TobiiBridge` 的 EXE，執行後保持橋接視窗開啟。毋須啟動桌面遊戲，也不另外散布 Tobii SDK DLL。
3. 在同一台電腦以 Chrome 或 Edge 開啟網頁／PWA，選擇「Tobii Eye Tracker 5」。若瀏覽器詢問本機網路存取，請允許；被拒絕時可在網址列的網站權限中重新設定。
4. 把遊戲移到裝有 ET5 的螢幕，點擊遊戲內「全螢幕（Tobii 注視判定）」，再按「開始遊戲」，完成中立點與四方向校正。使用遊戲按鈕進入全螢幕，不以瀏覽器 F11 代替。
5. 結束後關閉橋接視窗。一次只開一個 Tobii 練習；分頁關閉或停止讀取五秒後，橋接會釋放裝置。

未進入全螢幕時仍可讀取原始頭部與視線資料，但不會猜測瀏覽器工具列的位置，也不計算注視十字的角度與成功率。多螢幕、混合 DPI 與螢幕縮放下的注視對位仍需實機驗收；螢幕比例檢查無法辨認兩台相同比例的螢幕，請自行確認 ET5 對應螢幕。

橋接只監聽 `127.0.0.1:17343`，只接受 `https://ian030590.github.io` 與本機開發網址 `http://127.0.0.1:4173` 的 JSON 命令，並限制單一分頁工作階段。GitHub Pages 同帳號的專案共用 origin，因此不把路徑視為安全邊界。橋接不提供檔案或任意 Tauri 命令，也不把眼動資料上傳至遠端。

## 紀錄

網頁／PWA 在場次結束時下載 CSV，儲存在瀏覽器下載位置。請允許下載，並在離開或關閉網頁前結束場次；尚未結束的資料在記憶體中，不能保證關閉分頁後保留。桌面版仍使用 EXE 旁的 `Data` 目錄，並另外儲存摘要 JSON。

## 開發與部署

```sh
npm ci
npm run build:web
npm test
python -m http.server 4173 --bind 127.0.0.1 --directory dist-web
```

開啟 `http://127.0.0.1:4173/`。請勿以 `file://` 開啟。部署內容在 `dist-web/`，所有資源、manifest 與 service worker 均採用相對路徑，可放在 `/FlyingMoo/` 專案路徑。

GitHub 專案的 Settings → Pages 選擇 GitHub Actions；推送 `main` 後，`pages.yml` 會先準備資源、執行測試，再發布。Windows 橋接與桌面 EXE 使用 `npm run build` 建置，見 [Tobii 接口](TOBII.md) 與 [更新紀錄](releases/)。
