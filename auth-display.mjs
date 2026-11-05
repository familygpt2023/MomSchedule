#!/usr/bin/env node
// お母様のカレンダー（読むだけ）とToDo（チェックを付ける）の認証を行い、Renderに入れる値を表示する（一回きり）。
// 使い方:  node auth-display.mjs
// ブラウザが開くので、お母様のGoogleアカウント（hisakosv3）でログインして許可してください。
// 結果は ~/.gmail-mom/display-token.json にも保存します（このフォルダの外なので、GitHubには上がりません）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const HOME = os.homedir();
const KEY_CANDIDATES = [
  process.env.GMAIL_MOM_KEYS,
  path.join(HOME, '.gmail-mom', 'gcp-oauth.keys.json'),
  path.join(HOME, '.gmail-mcp', 'gcp-oauth.keys.json'),
].filter(Boolean);
const KEYS_PATH = KEY_CANDIDATES.find((p) => fs.existsSync(p));
const OUT_PATH = path.join(HOME, '.gmail-mom', 'display-token.json');

// 予定は閲覧のみ。ToDoはチェック（完了／未完了）を付けるために書き込み権限が必要。メールは含まない。
// ※Googleのタスク権限は細かく分けられないため、権限上は全ToDoリストを変更できる。
//   サーバーのプログラムは専用リスト「見守りめーる」の完了／未完了しか変更しない。
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

const die = (m) => { console.error('\n[エラー] ' + m + '\n'); process.exit(1); };
if (!KEYS_PATH) die('gcp-oauth.keys.json が見つかりません。');
const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
const cfg = raw.installed || raw.web;
if (!cfg?.client_id || !cfg?.client_secret) die('gcp-oauth.keys.json の形式が不正です。');

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');
let REDIRECT;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const page = (title, body) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center"><h1>${title}</h1><p style="color:#555">${body}</p></body>`);
  };
  if (url.searchParams.get('error')) { page('認可されませんでした', url.searchParams.get('error')); server.close(); process.exit(1); }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400).end(); return; }
  if (url.searchParams.get('state') !== state) { page('エラー', 'state不一致'); server.close(); process.exit(1); }

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.client_id, client_secret: cfg.client_secret,
        redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier,
      }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.refresh_token) {
      page('取得に失敗しました', '画面を閉じて、ターミナルの表示を確認してください。');
      console.error('\n[エラー] トークン取得失敗:', tok);
      console.error('refresh_token が返らない場合は https://myaccount.google.com/permissions で該当アプリのアクセスを削除して、やり直してください。');
      server.close(); process.exit(1);
    }

    // 誰を認可したか確認（カレンダーの持ち主のアドレス）
    let who = '(不明)';
    try {
      const c = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (c.ok) who = (await c.json()).id;
    } catch {}

    // 合言葉は以前のものがあれば引き継ぐ（iPadのアドレスを変えなくてよいように）
    let accessKey = '';
    try { accessKey = (fs.readFileSync(OUT_PATH, 'utf8').match(/^ACCESS_KEY=(\S{16,})$/m) || [])[1] || ''; } catch {}
    const reused = !!accessKey;
    if (!accessKey) accessKey = crypto.randomBytes(24).toString('hex');   // 新規は48文字
    const envText =
      `GOOGLE_CLIENT_ID=${cfg.client_id}\n` +
      `GOOGLE_CLIENT_SECRET=${cfg.client_secret}\n` +
      `GOOGLE_REFRESH_TOKEN=${tok.refresh_token}\n` +
      `ACCESS_KEY=${accessKey}\n`;
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, envText, { mode: 0o600 });

    page('設定が完了しました', `${who} を認可しました（予定は閲覧のみ／ToDoはチェック可）。このウィンドウを閉じて、ターミナルを見てください。`);
    console.log('\n==================================================');
    console.log(` 認可したアカウント: ${who}`);
    console.log(` 権限: ${tok.scope}`);
    console.log('==================================================');
    console.log(reused ? '\n合言葉(ACCESS_KEY)は以前のままです。Renderでは GOOGLE_REFRESH_TOKEN だけ更新すれば足ります。' : '\n下の4行を、Renderの Environment に1つずつ登録します。');
    console.log('（人に見せたり、チャットに貼ったりしないでください）\n');
    console.log(envText);
    console.log(`同じ内容を保存しました: ${OUT_PATH}\n`);
    server.close(); setTimeout(() => process.exit(0), 300);
  } catch (e) { page('エラー', String(e)); console.error(e); server.close(); process.exit(1); }
});

server.listen(0, '127.0.0.1', () => {
  REDIRECT = `http://127.0.0.1:${server.address().port}`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cfg.client_id, redirect_uri: REDIRECT, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  console.log('\n===========================================================');
  console.log(' お母様のGoogleアカウント（hisakosv3）でログインしてください。');
  console.log(' 要求する権限: 予定の閲覧 と ToDoのチェック（メール・予定の変更は不可）。');
  console.log('===========================================================\n');
  console.log('ブラウザが開かない場合は、次のURLを手動で開いてください:\n');
  console.log(authUrl + '\n');
  const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(cmd, () => {});
});
