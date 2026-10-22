# 第三方元件與授權聲明 (Third-Party Notices)

本專案使用以下開源元件與第三方技術：

## 1. Google MediaPipe Tasks Vision & Face Landmarker
- **授權**：Apache License 2.0
- **套件**：`@mediapipe/tasks-vision`
- **來源**：[google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe)，目前隨附 JavaScript SDK 0.10.20。
- **模型**：`face_landmarker.task` (float16)
- **用途**：透過一般相機與 Web Worker 於本機即時估計臉部三維朝向（Yaw、Pitch、Roll）。所有影像均於使用者裝置本機記憶體處理，不進行錄影或雲端傳輸。

## 2. Tauri 2.0
- **授權**：MIT License / Apache License 2.0
- **版權**：Copyright 2019-2026 Tauri Programme within The Commons Conservancy
- **用途**：Windows 桌面視窗封裝與 WebView2 原生橋接宿主。

## 3. Tobii Stream Engine
- **供應商**：Tobii AB
- **用途**：使用 `tobii_head_pose_subscribe` 取得 Tobii Eye Tracker 5 的即時頭部姿態。
- **部署**：從使用者已安裝的 Tobii Experience 官方目錄動態載入 `tobii_stream_engine.dll`。本專案不內嵌、複製或隨 EXE 散布該 DLL。
- **資料**：以官方 `STORE_OR_TRANSFER_FALSE` 模式開啟裝置；Tobii 姿態只供即時互動，不建立該來源的 CSV、不匯出追蹤歷程。使用範圍仍依使用者取得的 Tobii 授權。

## 4. WebAudio Procedural Synthesizer
- **用途**：程序式風聲與倒數提示音，無外部音效素材版權問題。牛叫與羊叫改用第 6 節記錄的 CC0 音效。

## 5. 遊戲角色圖片（CC0）

以下素材已下載至 `wwwroot/assets/animals/`，遊戲執行時不連線取得圖片。使用現成照片與插畫，未使用 AI 生成或自行繪製角色。

| 本機檔案 | 作品與作者 | 來源 | 處理方式 |
| --- | --- | --- | --- |
| `cow-side.png`、`src-tauri/icons/icon.ico` | Brown cow from side，ELL3G4NCE | [PurePNG](https://purepng.com/photo/421/brown-cow-from-side) | 原始去背側面照片，保持比例縮放；Windows 圖示由同一照片轉換格式 |
| `white-wing.svg` | Angel's wing，pipik | [Openclipart #95965](https://openclipart.org/detail/95965/angels-wing-by-pipik) | 沿用原始輪廓與羽毛線條，填入白色並收緊 viewBox；遊戲中旋轉素材形成雙翼與拍動效果 |
| `sheep-cute.png` | White Stupid & Cute Cartoon Sheep，qubodup | [Openclipart #190148](https://openclipart.org/detail/190148/white-stupid-cute-cartoon-sheep) | 使用網站提供的 800px 透明 PNG，保持比例縮放 |

- **授權**：[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)。
- **牛照片授權依據**：PurePNG 的作品頁與網站說明標示為 CC0、可商用且不需署名。
- **翅膀與羊授權依據**：[Openclipart 官方 FAQ](https://openclipart.org/share) 說明每次上傳均採用 CC0；[翅膀的 ClipSafari 頁面](https://www.clipsafari.com/clips/o95965-angel-wings) 亦明確標示 CC0。
- **來源及授權查核日期**：2026-10-21。

## 6. 動物叫聲（CC0）

以下現成錄音下載至 `wwwroot/assets/audio/`，桌面版與 HTML 版均從本機播放，無須連線。檔案未裁切或合成，僅在播放時降低音量。

| 本機檔案 | 作品與作者 | 來源及原始檔案 | 授權 |
| --- | --- | --- | --- |
| `sheep-bleat.ogg` | Sheep Baa，AntumDeluge；原始錄音 mikewest | [作品頁](https://opengameart.org/content/sheep-baa) · [原始 OGG](https://opengameart.org/sites/default/files/sheep_baa_0.ogg) · [原始錄音頁](https://freesound.org/people/mikewest/sounds/414342/) | CC0 1.0 |
| `cow-moo.mp3` | Cow moos #3，Joseph SARDIN / BigSoundBank | [作品頁](https://bigsoundbank.com/cow-moos-3-s2383.html) · [原始 MP3](https://bigsoundbank.com/UPLOAD/mp3/2383.mp3) | CC0（Public Domain） |

- **授權依據**：以上作品頁均明確標示 CC0，可免費商用、修改及隨作品散布，不要求署名。
- **播放時機**：每隻羊首次成功通過時播放一次羊叫，保留碰撞時的羊叫；牛叫保留原本倒數與開場的觸發點，遊戲開始約 4 秒後一聲，其後每 6～13 秒隨機播放一次。
- **來源及授權查核日期**：2026-10-21。

## 7. One Euro Filter

- **來源**：[casiez/OneEuroFilter](https://github.com/casiez/OneEuroFilter)，依其 JavaScript 版本改寫為毫秒時鐘介面。
- **用途**：以自適應截止頻率濾波頭部朝向，取代固定 EMA。
- **授權**：BSD 3-Clause，Copyright 2019 Inria。

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
