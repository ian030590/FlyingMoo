# 分離與後製音效

原始錄音維持不變。混合錄音的類別順序由使用者確認為「豬、牛、羊」，依波形中的停頓切開；未使用生成音效。

| 輸出 | 來源 | 裁切區間 | 用途 |
| --- | --- | --- | --- |
| `pig-grunt.wav` | `New Recording 21.m4a` | 1.60–4.90 秒 | 獨立豬叫，未加入遊戲 |
| `cow-moo-take-2.wav` | `New Recording 21.m4a` | 5.27–7.34 秒 | 混合錄音中的牛叫備選 |
| `sheep-bleat.wav` | `New Recording 21.m4a` | 8.62–10.06 秒 | 遊戲羊叫母檔 |
| `cow-moo.wav` | `哞.m4a` | 2.64–4.06 秒 | 遊戲牛叫母檔 |

WAV 為 48 kHz、單聲道、24-bit PCM。遊戲使用 `wwwroot/assets/audio/` 內的 128 kbps MP3，保留原本播放時機、重疊播放及靜音控制。

處理包含 70 Hz 高通、8 kHz 低通、安靜片段取樣的 FFT 降噪、動態壓縮、12 ms 淡入與 60 ms 淡出，以及兩階段響度正規化。目標為 −14 LUFS、−1.5 dBTP；各檔實際量測值記錄在 [audio-report.json](audio-report.json)，不把目標當作輸出保證。遊戲 MP3 約 −14.4 LUFS，真峰低於 −2 dBTP。

已驗證檔案解碼、非靜音、實際響度與真峰，以及瀏覽器播放。尚未進行人工聽感驗收，錄音內與叫聲重疊的聲音不能保證完全去除。

需要重新輸出時，將原始檔放在 `assets/`，安裝 FFmpeg 後執行：

```sh
node scripts/prepare-audio.cjs
```
