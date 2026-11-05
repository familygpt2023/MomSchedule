# MomSchedule

iPad常時表示用の予定表（Googleカレンダー／ToDoを読み取り専用で表示）。Renderの Web Service で動かします。

- 起動: `node server.mjs`（Node 20以上、依存パッケージなし）
- 必要な環境変数: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` / `ACCESS_KEY` / `TZ=Asia/Tokyo`
- 画面: `https://<サービス>.onrender.com/?key=<ACCESS_KEY>`
