// 母の予定表（iPad常時表示用）サーバー — 依存パッケージなし、Node 20以上
// お母様のGoogleカレンダーとToDo「見守りめーる」リストを「読み取るだけ」。書き込みは一切しない。
//
// 環境変数（Renderの Environment に設定する）:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN  … auth-display.mjs が表示する値
//   ACCESS_KEY … 長い合言葉。URLの ?key= に付ける。違うとページもデータも見せない
//   MOCK=1     … 動作確認用のサンプルデータ（Googleには接続しない）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MOCK = process.env.MOCK === '1';
const KEY = process.env.ACCESS_KEY || '';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH = process.env.GOOGLE_REFRESH_TOKEN;
const LIST_TITLE = '見守りめーる';
const JST = 9 * 3600e3;
const DAY = 864e5;

if (!KEY || KEY.length < 16) {
  console.error('ACCESS_KEY（16文字以上の合言葉）が設定されていません。公開を防ぐため起動を中止します。');
  process.exit(1);
}
if (!MOCK && !(CLIENT_ID && CLIENT_SECRET && REFRESH)) {
  console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN が必要です。');
  process.exit(1);
}

/* ---------- 認証（読み取り用トークンをメモリ内だけで更新） ---------- */

let access = null, accessExp = 0;
async function accessToken() {
  if (access && Date.now() < accessExp - 60e3) return access;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: REFRESH, grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`トークン更新に失敗 (${r.status}) ${j.error || ''}`);
  access = j.access_token;
  accessExp = Date.now() + (j.expires_in ?? 3600) * 1000;
  return access;
}
async function google(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!r.ok) throw new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/* ---------- データ作成 ---------- */

const jstMidnight = (now) => {
  const j = new Date(now.getTime() + JST); j.setUTCHours(0, 0, 0, 0);
  return new Date(j.getTime() - JST);
};

async function fromGoogle() {
  const day0 = jstMidnight(new Date());
  const q = new URLSearchParams({
    timeMin: day0.toISOString(), timeMax: new Date(day0.getTime() + 8 * DAY).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '100',
  });
  const ev = await google(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
  const events = (ev.items || []).filter((e) => e.status !== 'cancelled').map((e) => {
    const hidden = e.visibility === 'private' || e.visibility === 'confidential';
    return {
      id: e.id,
      title: hidden ? '予定あり' : (e.summary || '（題名なし）'),
      location: hidden ? '' : (e.location || ''),
      allDay: !!e.start?.date,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
    };
  });

  let tasks = [];
  try {
    const lists = await google('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100');
    const mine = (lists.items || []).find((l) => l.title === LIST_TITLE);
    if (mine) {
      const t = await google(`https://tasks.googleapis.com/tasks/v1/lists/${mine.id}/tasks?maxResults=50&showCompleted=false`);
      tasks = (t.items || []).filter((x) => x.title).map((x) => ({
        id: x.id, title: x.title, notes: x.notes || '', due: x.due ? x.due.slice(0, 10) : '',
      }));
    }
  } catch (e) { console.error('ToDo取得失敗:', e.message); }
  return { events, tasks };
}

function sample() {
  const d0 = jstMidnight(new Date()).getTime();
  const at = (days, h, m = 0) => new Date(d0 + days * DAY + (h * 60 + m) * 60e3).toISOString();
  const date = (days) => new Date(d0 + JST + days * DAY).toISOString().slice(0, 10);
  return {
    events: [
      { id: 'a', title: '体操教室', location: '公民館', allDay: false, start: at(0, 9), end: at(0, 10, 30) },
      { id: 'b', title: 'かかりつけ医の電話予約', location: '', allDay: false, start: at(0, 14), end: at(0, 14, 30) },
      { id: 'c', title: '息子と寿司屋へ', location: '駅前の寿司屋', allDay: false, start: at(0, 17), end: at(0, 19) },
      { id: 'd', title: '燃えるごみの日', location: '', allDay: true, start: date(1), end: date(2) },
      { id: 'e', title: '歯医者', location: '田中歯科', allDay: false, start: at(1, 10, 30), end: at(1, 11, 30) },
      { id: 'f', title: '孫が遊びに来る', location: '', allDay: false, start: at(3, 13), end: at(3, 16) },
      { id: 'g', title: '町内会の集まり', location: '集会所', allDay: false, start: at(5, 10), end: at(5, 11, 30) },
    ],
    tasks: [
      { id: 't1', title: '息子と寿司屋へ行く準備', notes: '', due: date(0) },
      { id: 't2', title: '薬を飲む', notes: '朝と夜', due: date(0) },
    ],
  };
}

let cache = null, cacheAt = 0, inflight = null, lastError = '';
async function getData() {
  if (cache && Date.now() - cacheAt < 60e3) return { ...cache, stale: false };
  inflight ||= (async () => {
    try {
      const d = MOCK ? sample() : await fromGoogle();
      cache = { ...d, updated: new Date().toISOString() };
      cacheAt = Date.now(); lastError = '';
    } catch (e) { lastError = e.message; console.error(new Date().toISOString(), e.message); }
    finally { inflight = null; }
  })();
  await inflight;
  if (!cache) throw new Error(lastError || 'データを取得できません');
  return { ...cache, stale: !!lastError };
}

/* ---------- HTTP ---------- */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keyOk = (k) => crypto.timingSafeEqual(sha(k || ''), sha(KEY));
const HTML = fs.readFileSync(path.join(HERE, 'index.html'));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const base = {
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  };
  const send = (code, type, body) => { res.writeHead(code, { ...base, 'Content-Type': type }); res.end(body); };

  if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok');
  if (url.pathname === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /\n');
  if (url.pathname === '/' || url.pathname === '/api/data') {
    if (!keyOk(url.searchParams.get('key'))) return send(404, 'text/plain', 'Not found');
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', HTML);
    try { return send(200, 'application/json; charset=utf-8', JSON.stringify(await getData())); }
    catch (e) { return send(502, 'application/json; charset=utf-8', JSON.stringify({ error: e.message })); }
  }
  send(404, 'text/plain', 'Not found');
}).listen(PORT, () => console.log(`予定表サーバー起動: port ${PORT}${MOCK ? '（サンプルデータ）' : ''}`));
