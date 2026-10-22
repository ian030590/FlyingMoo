# 發版規則

- 發版前先查 GitHub Releases、遠端 tags 與本機版本。每次正常發版使用新的版本號，不重用或覆寫已發布的版本、tag 或附件。
- 優先採用使用者指定的新版本；未指定時依變更範圍遞增 SemVer：修正升 patch、相容的新功能升 minor、不相容變更升 major。
- 同步更新 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 中 FlyingMoo 套件的版本，以及 `src-tauri/tauri.conf.json`。不要改到其他依賴的版本。
- 每版新增獨立的 `docs/releases/vX.Y.Z.md`。已發布版本的紀錄保留，除非使用者明確要求更正；不要將上一版的檔案直接改寫成新版。
- `README.md` 保留長期使用與建置說明，不放單版 release notes、固定版本的產物檔名或「本版」更新入口。下載連到 GitHub latest，更新紀錄連到 `docs/releases/`。
- GitHub Release 使用該版檔案作為 `--notes-file`，並附上相符版本的 EXE 與 SHA-256。發布前完成適用測試及建置，確認來源 commit/tag、檔名與執行檔內版本一致；發布後驗證附件下載及校驗碼。
- Release notes 清楚區分實機驗證、合成測試與尚未驗收的項目，不把可編譯或合成姿態當成完整硬體驗收。
