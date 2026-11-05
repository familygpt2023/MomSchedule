// 母の予定表（iPad常時表示用）サーバー — 依存パッケージなし、Node 20以上
// 読むもの : お母様のGoogleカレンダーの予定 と ToDo専用リスト「見守りめーる」
// 書くもの : ToDo専用リスト「見守りめーる」のタスクの「完了／未完了」だけ（題名や期限は変えない）
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
const SCOPE_TASKS_WRITE = 'https://www.googleapis.com/auth/tasks';
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

/* ---------- 認証（トークンはメモリ内だけで更新） ---------- */

let access = null, accessExp = 0, grantedScope = '';
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
  grantedScope = j.scope || grantedScope;
  return access;
}
async function google(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? {} : r.json();
}
const canCheck = () => MOCK || grantedScope.split(/\s+/).includes(SCOPE_TASKS_WRITE);

/* ---------- データ作成 ---------- */

const jstMidnight = (now) => {
  const j = new Date(now.getTime() + JST); j.setUTCHours(0, 0, 0, 0);
  return new Date(j.getTime() - JST);
};

let listId = null;
async function managedListId() {
  if (listId) return listId;
  const lists = await google('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100');
  listId = (lists.items || []).find((l) => l.title === LIST_TITLE)?.id || null;
  return listId;
}

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
      notes: hidden ? '' : String(e.description || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 400),
      allDay: !!e.start?.date,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
    };
  });

  let tasks = [];
  try {
    const id = await managedListId();
    if (id) {
      const t = await google(`https://tasks.googleapis.com/tasks/v1/lists/${id}/tasks?maxResults=100&showCompleted=true&showHidden=true`);
      tasks = (t.items || []).filter((x) => x.title).flatMap((x) => {
        const done = x.status === 'completed';
        if (done && !(x.completed && Date.parse(x.completed) >= day0.getTime())) return [];   // きょう完了したものだけ残す
        return [{ id: x.id, title: x.title, notes: x.notes || '', due: x.due ? x.due.slice(0, 10) : '', done }];
      });
    }
  } catch (e) { console.error('ToDo取得失敗:', e.message); }
  return { events, tasks };
}

// 動作確認用のサンプル
const mockTasks = [
  { id: 't1', title: '息子と寿司屋へ行く準備', notes: '', due: '', done: false },
  { id: 't2', title: '薬を飲む', notes: '朝と夜', due: '', done: false },
  { id: 't3', title: '洗濯物を取り込む', notes: '', due: '', done: true },
];
function sample() {
  const d0 = jstMidnight(new Date()).getTime();
  const at = (days, h, m = 0) => new Date(d0 + days * DAY + (h * 60 + m) * 60e3).toISOString();
  const date = (days) => new Date(d0 + JST + days * DAY).toISOString().slice(0, 10);
  return {
    events: [
      { id: 'a', title: '体操教室', location: '公民館', notes: '動きやすい服で。タオルを持っていく。', allDay: false, start: at(0, 9), end: at(0, 10, 30) },
      { id: 'b', title: 'かかりつけ医の電話予約', location: '', notes: '保険証を手元に置いておく。', allDay: false, start: at(0, 14), end: at(0, 14, 30) },
      { id: 'c', title: '息子と寿司屋へ', location: '駅前の寿司屋', notes: '17時に迎えに来る。', allDay: false, start: at(0, 17), end: at(0, 19) },
      { id: 'd', title: '燃えるごみの日', location: '', notes: '', allDay: true, start: date(1), end: date(2) },
      { id: 'e', title: '歯医者', location: '田中歯科', notes: '', allDay: false, start: at(1, 10, 30), end: at(1, 11, 30) },
      { id: 'f', title: '孫が遊びに来る', location: '', notes: '', allDay: false, start: at(3, 13), end: at(3, 16) },
      { id: 'g', title: '町内会の集まり', location: '集会所', notes: '', allDay: false, start: at(5, 10), end: at(5, 11, 30) },
    ],
    tasks: mockTasks.map((t) => ({ ...t })),
  };
}

let cache = null, cacheAt = 0, inflight = null, lastError = '';
async function getData(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60e3) return { ...cache, canCheck: canCheck(), stale: false };
  if (!inflight) {
    const refresh = async () => {
      try {
        const d = MOCK ? sample() : await fromGoogle();
        cache = { ...d, updated: new Date().toISOString() };
        cacheAt = Date.now(); lastError = '';
      } catch (e) { lastError = e.message; console.error(new Date().toISOString(), e.message); }
    };
    inflight = refresh().finally(() => { inflight = null; });   // 同時に何度も取りに行かない
  }
  await inflight;
  if (!cache) throw new Error(lastError || 'データを取得できません');
  return { ...cache, canCheck: canCheck(), stale: !!lastError };
}

// ToDoの完了／未完了だけを変える（専用リストの中のタスクに限る）
async function setTaskDone(id, done) {
  if (MOCK) {
    const t = mockTasks.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error('見つかりません'), { status: 404 });
    t.done = done;
    return;
  }
  if (!canCheck()) await accessToken();
  if (!canCheck()) throw Object.assign(new Error('チェックの権限がありません（認証をやり直してください）'), { status: 403 });
  const lid = await managedListId();
  if (!lid) throw Object.assign(new Error('専用リストがありません'), { status: 404 });
  await google(`https://tasks.googleapis.com/tasks/v1/lists/${lid}/tasks/${encodeURIComponent(id)}`, 'PATCH',
    done ? { status: 'completed' } : { status: 'needsAction', completed: null });
}

/* ---------- HTTP ---------- */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keyOk = (k) => crypto.timingSafeEqual(sha(k || ''), sha(KEY));
const HTML = fs.readFileSync(path.join(HERE, 'index.html'));
const VERSION = crypto.createHash('sha256').update(HTML).digest('hex').slice(0, 12);   // ページの版。新しい版を出すと変わる（画面側はこれを見て読み込み直す）
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 2048) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const base = {
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  };
  const send = (code, type, body) => { res.writeHead(code, { ...base, 'Content-Type': type }); res.end(body); };
  const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));

  if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok');
  if (url.pathname === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /\n');

  if (['/', '/api/data', '/api/task'].includes(url.pathname)) {
    if (!keyOk(url.searchParams.get('key'))) return send(404, 'text/plain', 'Not found');
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', HTML);
    try {
      if (url.pathname === '/api/data') return json(200, { ...(await getData()), version: VERSION });
      // POST /api/task  {id, done}
      if (req.method !== 'POST') return json(405, { error: 'POSTで呼んでください' });
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(400, { error: '形式が正しくありません' }); }
      if (typeof b.id !== 'string' || !b.id || b.id.length > 200 || typeof b.done !== 'boolean') return json(400, { error: '形式が正しくありません' });
      await setTaskDone(b.id, b.done);
      return json(200, { ...(await getData(true)), version: VERSION });
    } catch (e) { return json(e.status || 502, { error: e.message }); }
  }
  send(404, 'text/plain', 'Not found');
}).listen(PORT, () => console.log(`予定表サーバー起動: port ${PORT}${MOCK ? '（サンプルデータ）' : ''}`));
