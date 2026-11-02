// Đố Vui LIVE — server
// Runs on the streaming PC. Reads a TikTok LIVE room, runs quiz rounds, scores answers from comments,
// voices questions with Edge TTS and pushes everything to the overlay over WebSocket.
//
// Questions come in two tiers:
//   1. Google Sheet, in sheet order; a question asked within `repeatAfterMin` (default 2 h) is skipped
//   2. when every sheet question is that recent → Gemini makes new ones (prefetched in the background)
//      → if Gemini is off or fails → the sheet starts over (question asked longest ago first)
//
//   cd do-vui && npm install && npm start        → http://localhost:3100
//
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { norm, answerSet, isCorrect, autoHint, questionsFromCSV, sheetCsvUrl, pickFresh, pickOldest, validateGemini, parseChat, cleanChat } from './core.mjs';
import { TeamMatch, looksLikeAnswer, JOIN_WORDS } from './teams.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data'), TTS_DIR = path.join(DATA, 'tts'), ASSETS = path.join(DIR, 'assets'), PUBLIC = path.join(DIR, 'public');
for (const d of [DATA, TTS_DIR, ASSETS]) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }

// .env next to this file (GEMINI_API_KEY, GEMINI_MODEL, PORT, HOST). Never sent to the browser.
try { for (const line of fs.readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch {}
const PORT = +process.env.PORT || 3100;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

/* ------------------------------------------------------------- storage */
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const saveTimers = {};
function saveJSON(f, v){ clearTimeout(saveTimers[f]); saveTimers[f] = setTimeout(() => { try { fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1)); } catch (e) { console.error(e); } }, 400); }

/* ------------------------------------------------------------ settings */
const DEFAULTS = {
  title: 'ĐỐ VUI', subtitle: 'Bình luận đáp án · ai nhanh nhất được nhiều điểm',
  sheetUrl: '', repeatAfterMin: 120,
  roundSec: 25, hintAtSec: 12, graceSec: 4, revealSec: 7, gapSec: 5,
  readQuestion: true, voice: 'vi-VN-HoaiMyNeural', pitch: 0, rate: 0,
  giftBoost: true, music: true, musicVol: 35, showGuesses: true,
  geminiEnabled: true, geminiVerify: true,
  mode: 'solo',                                  // solo | team
  teamCount: 2, teamNames: 'Đỏ|Xanh|Vàng', matchMin: 15, teamQuestionSec: 30, stairSteps: 12, teamMax: 20, wrongStepDown: true, breakSec: 60, lobbySec: 15,
  chatEnabled: true, chatCooldownSec: 15,
  geminiTopics: 'tục ngữ ca dao, câu đố dân gian, địa lý Việt Nam, ẩm thực Việt Nam, lịch sử Việt Nam, khoa học phổ thông, động vật, thực vật, đố mẹo, tiếng Việt',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
const str = n => v => String(v ?? '').slice(0, n);
const SETTING_RULES = {
  title: str(48), subtitle: str(80), geminiTopics: str(400),
  sheetUrl: v => { const s = String(v ?? '').trim().slice(0, 500); return !s || sheetCsvUrl(s) ? s : settings.sheetUrl; },
  repeatAfterMin: v => clamp(v, 10, 1440), roundSec: v => clamp(v, 10, 90), hintAtSec: v => clamp(v, 0, 90),
  graceSec: v => clamp(v, 0, 15), revealSec: v => clamp(v, 3, 20), gapSec: v => clamp(v, 2, 30),
  voice: v => ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), musicVol: v => clamp(v, 0, 100),
  readQuestion: Boolean, giftBoost: Boolean, music: Boolean, showGuesses: Boolean, geminiEnabled: Boolean, geminiVerify: Boolean,
  mode: v => v === 'team' ? 'team' : 'solo', teamCount: v => clamp(v, 2, 3),
  teamNames: v => String(v ?? '').split('|').map(s => s.trim().slice(0, 14)).filter(Boolean).slice(0, 3).join('|') || DEFAULTS.teamNames,
  matchMin: v => clamp(v, 3, 60), teamQuestionSec: v => clamp(v, 15, 120), stairSteps: v => clamp(v, 5, 25), teamMax: v => clamp(v, 1, 200), breakSec: v => clamp(v, 10, 300),
  wrongStepDown: Boolean, chatEnabled: Boolean, lobbySec: v => clamp(v, 5, 120), chatCooldownSec: v => clamp(v, 0, 300),
};
const settings = { ...DEFAULTS };
applySettings(readJSON('settings.json', {}));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (o && k in o) settings[k] = fn(o[k]); }

/* ---------------------------------------------------------------- log */
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 400) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

/* ------------------------------------------------------ question bank */
// history: question id → last time asked (ms). Kept on disk so a restart doesn't repeat the last 2 hours.
const history = new Map(Object.entries(readJSON('history.json', {})));
function markAsked(id){ history.set(id, Date.now()); const cut = Date.now() - 3 * 864e5; for (const [k, t] of history) if (t < cut) history.delete(k); saveJSON('history.json', Object.fromEntries(history)); }

let bank = [], bankInfo = { source: '', loadedAt: 0, errors: [], status: 'chưa tải' };
const LOCAL_BANK = path.join(DIR, 'cau-hoi-mau.csv');
async function loadBank(){
  const url = sheetCsvUrl(settings.sheetUrl);
  if (url){
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (/html/i.test(type)) throw new Error('Sheet chưa chia sẻ công khai (cần "Bất kỳ ai có đường liên kết đều xem được")');
      const text = await r.text(), { questions, errors } = questionsFromCSV(text);
      if (!questions.length) throw new Error(errors[0] || 'Sheet không có câu hỏi');
      bank = questions; bankInfo = { source: 'Google Sheet', loadedAt: Date.now(), errors, status: 'ok' };
      fs.writeFileSync(path.join(DATA, 'sheet-cache.csv'), text);
      addLog(`📄 Tải Google Sheet: ${bank.length} câu${errors.length ? `, ${errors.length} dòng lỗi` : ''}`);
      return broadcastBank();
    } catch (e) {
      addLog('📄 Không tải được Google Sheet: ' + (e?.message || e));
      bankInfo.status = 'lỗi: ' + (e?.message || e);
      const cache = path.join(DATA, 'sheet-cache.csv');
      if (fs.existsSync(cache) && !bank.length){ bank = questionsFromCSV(fs.readFileSync(cache, 'utf8')).questions; bankInfo.source = 'bản lưu của Sheet'; addLog(`📄 Dùng bản lưu lần trước: ${bank.length} câu`); }
      if (bank.length) return broadcastBank();
    }
  }
  const { questions, errors } = questionsFromCSV(fs.readFileSync(LOCAL_BANK, 'utf8'));
  bank = questions; bankInfo = { source: 'file mẫu cau-hoi-mau.csv', loadedAt: Date.now(), errors, status: url ? bankInfo.status : 'chưa đặt link Sheet' };
  addLog(`📄 Dùng ${bank.length} câu mẫu (chưa có Google Sheet)`);
  broadcastBank();
}
setInterval(loadBank, 5 * 60_000);                         // pick up edits to the sheet
function bankStats(){
  const cd = settings.repeatAfterMin * 60_000, now = Date.now();
  return { ...bankInfo, total: bank.length, fresh: bank.filter(q => now - (history.get(q.id) || 0) >= cd).length, geminiPool: geminiPool.length,
    gemini: GEMINI_KEY ? (settings.geminiEnabled ? geminiState : 'đã tắt') : 'chưa có GEMINI_API_KEY' };
}
function broadcastBank(){ broadcast({ t:'bank', ...bankStats() }, 'control'); }

/* ---------------------------------------------------------------- Gemini */
let geminiPool = [], geminiBusy = null, geminiFailAt = 0, geminiState = 'sẵn sàng';
const geminiOn = () => GEMINI_KEY && settings.geminiEnabled;

// "High demand" (503) and rate limits (429) are usually over in seconds: retry those twice before giving up.
async function geminiCall(prompt, schema){
  for (let attempt = 0; ; attempt++){
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(40_000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.9 } }),
    });
    const body = await r.json().catch(() => ({}));
    if ((r.status === 503 || r.status === 429) && attempt < 2){ addLog(`🤖 Gemini đang quá tải, thử lại lần ${attempt + 1}…`); await new Promise(res => setTimeout(res, 3000 + attempt * 5000)); continue; }
    if (!r.ok) throw new Error(body?.error?.message || 'HTTP ' + r.status);
    const text = (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    return JSON.parse(text);
  }
}

const Q_SCHEMA = { type: 'ARRAY', items: { type: 'OBJECT', required: ['cau_hoi', 'dap_an'], properties: {
  cau_hoi: { type: 'STRING' }, dap_an: { type: 'STRING' }, dap_an_khac: { type: 'ARRAY', items: { type: 'STRING' } },
  chu_de: { type: 'STRING' }, goi_y: { type: 'STRING' }, do_kho: { type: 'INTEGER' } } } };

async function geminiBatch(n = 10){
  const recent = [...bank, ...geminiPool].slice(-60).map(q => '- ' + q.q).join('\n');
  const prompt = `Bạn soạn câu đố cho một buổi livestream đố vui tiếng Việt. Người xem trả lời bằng cách gõ bình luận.
Hãy tạo ${n} câu đố MỚI, đa dạng, thuộc các chủ đề: ${settings.geminiTopics}.
Yêu cầu bắt buộc:
- Đáp án NGẮN (1 đến 3 từ), DUY NHẤT, chắc chắn đúng, ai cũng gõ được bằng điện thoại.
- Chỉ dùng kiến thức phổ biến, đã được xác minh. Không bịa ca dao, tục ngữ hay sự kiện. Không chắc thì bỏ câu đó.
- Từ 1/7/2025 Việt Nam đã sáp nhập còn 34 tỉnh, thành phố. Không hỏi về tỉnh và không nhắc tên tỉnh trong câu hỏi (dùng tên thành phố, địa danh, vùng miền thay thế).
- Câu hỏi tối đa 160 ký tự, rõ ràng, không đánh đố mơ hồ, không có nội dung chính trị, tôn giáo nhạy cảm, bạo lực hay người lớn.
- dap_an_khac: các cách viết khác vẫn được tính đúng (tên gọi khác, viết tắt, chữ số). goi_y: một gợi ý ngắn không lộ đáp án.
- do_kho từ 1 (dễ) đến 3 (khó), phần lớn là 1 và 2.
Không lặp lại các câu sau:
${recent || '(chưa có)'}`;
  let qs = validateGemini(await geminiCall(prompt, Q_SCHEMA), new Set([...bank, ...geminiPool].map(q => q.id)));
  if (settings.geminiVerify && qs.length){
    const list = qs.map((q, i) => `${i}. ${q.q} → ${q.a}`).join('\n');
    const ok = await geminiCall(`Bạn là người kiểm duyệt câu đố. Với mỗi câu dưới đây, kiểm tra kỹ: đáp án có CHẮC CHẮN đúng, duy nhất và câu hỏi có rõ ràng không.
Chỉ trả về mảng các số thứ tự của những câu đạt. Nghi ngờ thì loại.
${list}`, { type: 'ARRAY', items: { type: 'INTEGER' } });
    const keep = new Set(Array.isArray(ok) ? ok : []); const before = qs.length;
    qs = qs.filter((_, i) => keep.has(i));
    if (before !== qs.length) addLog(`🤖 Gemini tự kiểm tra: loại ${before - qs.length}/${before} câu`);
  }
  for (const q of qs) fs.appendFileSync(path.join(DATA, 'gemini-cau-hoi.csv'), csvRow([new Date().toISOString(), q.q, q.a, q.alt.join('|'), q.topic, q.level, q.hint]));
  return qs;
}
const csvRow = a => a.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',') + '\n';

// One request at a time; after a failure wait a minute before trying again.
function geminiFill(){
  if (!geminiOn()) return Promise.resolve();
  if (geminiBusy) return geminiBusy;
  if (Date.now() - geminiFailAt < 60_000) return Promise.resolve();
  geminiState = 'đang tạo câu…'; broadcastBank();
  geminiBusy = geminiBatch(10).then(qs => {
    geminiPool.push(...qs); geminiState = 'sẵn sàng'; addLog(`🤖 Gemini tạo thêm ${qs.length} câu (kho chờ: ${geminiPool.length})`);
    if (!qs.length) geminiFailAt = Date.now();
  }).catch(e => { geminiFailAt = Date.now(); geminiState = 'lỗi: ' + (e?.message || e); addLog('🤖 Gemini lỗi: ' + (e?.message || e)); })
    .finally(() => { geminiBusy = null; broadcastBank(); });
  return geminiBusy;
}

async function nextQuestion(){
  const cd = settings.repeatAfterMin * 60_000, now = Date.now();
  const fresh = pickFresh(bank, history, cd, now);
  if (fresh){
    looping = false;
    if (geminiOn() && geminiPool.length < 5 && bank.filter(q => now - (history.get(q.id) || 0) >= cd).length <= 4) geminiFill();   // prefetch before the sheet runs dry
    return { ...fresh, source: 'sheet' };
  }
  if (geminiOn()){
    if (!geminiPool.length) await Promise.race([geminiFill(), new Promise(r => setTimeout(r, 30_000))]);
    if (geminiPool.length){ const q = geminiPool.shift(); if (geminiPool.length < 4) geminiFill(); return { ...q, source: 'gemini' }; }
  }
  const old = pickOldest(bank, history);
  if (old){ if (!looping){ looping = true; addLog('🔁 Hết câu mới và Gemini không dùng được, quay lại đầu Sheet'); } return { ...old, source: 'sheet-lap-lai' }; }
  return null;
}
let looping = false;

/* --------------------------------------------------------------- players */
// Today's scoreboard, saved to disk and reset at midnight.
const today = () => new Date().toLocaleDateString('sv-SE');
let board = readJSON('scores.json', { day: today(), players: {} });
if (board.day !== today()) board = { day: today(), players: {} };
const boosts = new Map();                   // uid → { until, x }
function player(uid, name, avatar){
  if (board.day !== today()) board = { day: today(), players: {} };
  const p = board.players[uid] ||= { uid, name, avatar: '', score: 0, wins: 0, correct: 0, coins: 0 };
  if (name) p.name = String(name).slice(0, 24); if (avatar) p.avatar = avatar;
  return p;
}
const top = (n = 10) => Object.values(board.players).filter(p => p.score > 0).sort((a, b) => b.score - a.score || b.wins - a.wins).slice(0, n)
  .map(p => ({ uid: p.uid, name: p.name, avatar: p.avatar, score: p.score, boost: (boosts.get(p.uid)?.until || 0) > Date.now() }));
function saveBoard(){ saveJSON('scores.json', board); broadcast({ t:'board', top: top() }); }

/* ----------------------------------------------------------------- game */
const RANK_POINTS = [10, 7, 5];                 // 1st, 2nd, 3rd correct; everyone else correct gets 3
let running = false, round = null, roundNo = 0, phase = 'idle', phaseTimer = null, hintTimer = null;
const publicQ = r => ({ no: r.no, q: r.q.q, topic: r.q.topic, level: r.q.level, source: r.q.source, endsAt: r.endsAt, hint: r.hintShown ? r.hint : '' });

function setPhase(p, ms, fn){ phase = p; clearTimeout(phaseTimer); phaseTimer = ms != null ? setTimeout(fn, ms) : null; }

// Team mode: a match only starts from the lobby (fromLobby), once every team has a player.
async function startRound(fromLobby){
  if (!running) return;
  if (teamMode()){
    const m = ensureMatch();
    if (!m.startedAt){
      if (!fromLobby || !m.ready()) return enterLobby();
      m.start(Date.now(), settings.matchMin * 60_000); broadcastTeams();
      addLog(`🏁 Trận ${m.no} bắt đầu: ${settings.matchMin} phút, ${m.teams.length} đội, ${m.steps} bậc`);
      say(`Trận ${m.no} bắt đầu! Đúng thì leo một bậc${settings.wrongStepDown ? ', sai thì tụt một bậc' : ''}. Cố lên!`, { tag: 'match' });
    } else if (Date.now() >= m.endsAt) return endMatch();
  }
  setPhase('loading');
  const q = await nextQuestion();
  if (!running) return;
  if (!q){ addLog('⚠️ Không có câu hỏi nào. Kiểm tra Google Sheet.'); stopGame(); return; }
  markAsked(q.id);
  const now = Date.now(), team = teamMode();
  const sec = team ? settings.teamQuestionSec : settings.roundSec, hintAt = team ? Math.floor(sec / 2) : settings.hintAtSec;
  round = { no: ++roundNo, q, set: answerSet(q.a, q.alt), startedAt: now, endsAt: now + sec * 1000,
    correct: [], tried: new Map(), hint: q.hint || autoHint(q.a), hintShown: false, team, answers: new Map(), nCorrect: 0, heardAt: liveHeard };
  setPhase('question', sec * 1000, endRound);
  clearTimeout(hintTimer);
  if (hintAt > 0 && hintAt < sec) hintTimer = setTimeout(showHint, hintAt * 1000);
  broadcast({ t:'question', ...publicQ(round), now });
  broadcast({ t:'host', no: round.no, q: q.q, a: q.a, alt: q.alt, source: q.source, row: q.row || null }, 'control');
  if (settings.readQuestion) say(`Câu ${round.no}. ${q.q.replace(/_{2,}/g, '…')}`, { tag: 'question', no: round.no });
  addLog(`❓ Câu ${round.no} [${{ sheet: 'Sheet', gemini: 'Gemini', 'sheet-lap-lai': 'Sheet, lặp lại' }[q.source]}]: ${q.q} → ${q.a}`);
  botsRound();
}
function showHint(){ if (phase !== 'question' || !round) return; round.hintShown = true; broadcast({ t:'hint', hint: round.hint }); }

function onAnswer(uid, name, text, avatar){
  if (!uid) return;
  text = String(text || '').slice(0, 80);
  const chat = parseChat(text);
  if (chat != null) return onChatCmd(uid, name, avatar, chat);           // "/chat …" is never an answer
  if (teamMode()) return onTeamComment(uid, name, text, avatar);
  if (phase !== 'question' || !round){ return; }
  if (round.correct.some(c => c.uid === uid)) return;
  const n = (round.tried.get(uid) || 0) + 1; round.tried.set(uid, n);
  if (n > 6) return;                                          // stop brute-forcing with a list of guesses
  if (!isCorrect(text, round.set)){ if (settings.showGuesses && norm(text).length <= 30) broadcast({ t:'guess', name: String(name).slice(0, 24), text }); return; }
  const rank = round.correct.length;
  const b = boosts.get(uid), x = settings.giftBoost && b && b.until > Date.now() ? b.x : 1;
  const points = (RANK_POINTS[rank] ?? 3) * x, p = player(uid, name, avatar);
  p.score += points; p.correct++; if (rank === 0) p.wins++;
  round.correct.push({ uid, name: p.name, avatar: p.avatar, points, x });
  broadcast({ t:'correct', rank, name: p.name, avatar: p.avatar, points, x });
  if (rank === 0){
    const end = Date.now() + settings.graceSec * 1000;                   // a few more seconds for 2nd/3rd place
    if (end < round.endsAt){ round.endsAt = end; setPhase('question', settings.graceSec * 1000, endRound); broadcast({ t:'endsAt', endsAt: end, now: Date.now() }); }
  }
  saveBoard();
}

/* ------------------------------------------------------------ team mode */
// Ladder mode: one answer per person per question; climbing/dropping happens at the reveal so everyone moves together.
let match = null, lastMatchEnd = null;
const teamMode = () => settings.mode === 'team';
const teamNames = () => settings.teamNames.split('|');
function ensureMatch(){ return match ||= new TeamMatch({ names: teamNames(), count: settings.teamCount, steps: settings.stairSteps, max: settings.teamMax }); }

// Audience: viewers who commented but aren't in a team. Shown under the stairs, newest last; joining a team takes them off.
const audience = new Map(), AUD_MAX = 80;
const audList = () => [...audience.values()];
function addAudience(uid, name, avatar){
  if (match?.players.has(uid)) return;
  const had = audience.get(uid); audience.delete(uid);
  audience.set(uid, { uid, name: String(name || 'ẩn danh').slice(0, 24), avatar: avatar || had?.avatar || '' });
  if (audience.size > AUD_MAX){ const old = audience.keys().next().value; audience.delete(old); broadcast({ t:'aud', remove: old, total: audience.size }); }
  if (!had) broadcast({ t:'aud', add: audience.get(uid), total: audience.size });
}
function removeAudience(uid){ if (audience.delete(uid)) broadcast({ t:'aud', remove: uid, total: audience.size }); }
function broadcastTeams(){ broadcast({ t:'teams', match: match.public() }); }

function teamJoin(uid, name, avatar, team){
  const m = ensureMatch(), r = m.join(uid, name, avatar, team);
  if (r.allFull || (r.full && !r.p)){                                    // no room: stay in the audience
    addAudience(uid, name, avatar);
    nudge(uid + ':full', r.allFull ? `${String(name).slice(0, 24)}: các đội đã đủ ${m.max} người, mời bạn xem ở khán đài` : `${String(name).slice(0, 24)}: đội ${m.teams[r.team].name} đã đủ ${m.max} người, gõ "tham gia" để vào đội còn chỗ`, 10_000, true);
    return r;
  }
  if (r.full){ nudge(uid + ':full', `${r.p.name}: đội ${m.teams[r.team].name} đã đủ người`, 10_000, true); return r; }
  const tn = m.teams[r.p.team].name;
  if (r.joined) removeAudience(uid);
  if (r.joined || r.switched){
    broadcast({ t:'tjoin', p: { uid, name: r.p.name, avatar: r.p.avatar, team: r.p.team, step: r.p.step }, switched: !!r.switched, teams: m.stats() });
    addLog(r.switched ? `🔀 ${r.p.name} chuyển sang đội ${tn}` : `➕ ${r.p.name} vào đội ${tn}`);
  }
  if (r.locked) nudge(uid + ':switch', `${r.p.name}: mỗi trận chỉ đổi đội 1 lần`, 20_000, true);
  if (r.lastOne) nudge(uid + ':switch', `${r.p.name} là người cuối của đội ${tn}, chưa rời đội được`, 20_000, true);
  if (phase === 'lobby') lobbyCheck();
  return r;
}
// Short on-screen notes to one viewer. Limited per person and kind (key), and to one hint every few seconds overall,
// so a busy room never floods the screen. Replies to an explicit request (team full…) pass `urgent` and only wait 2 s.
const nudged = new Map(); let lastNudge = 0;
function nudge(key, text, every = 20_000, urgent = false){
  const now = Date.now();
  if (now - (nudged.get(key) || 0) < every || now - lastNudge < (urgent ? 2000 : 8000)) return;
  nudged.set(key, now); lastNudge = now; if (nudged.size > 5000) nudged.clear();
  broadcast({ t:'nudge', text });
}
// Joining is explicit: "tham gia" (smallest team) or a team's name. Everything else from a team member may be an answer.
function onTeamComment(uid, name, text, avatar){
  const m = ensureMatch(), n = norm(text), asking = phase === 'question' && round?.team;
  const isAnswer = asking && round.set.has(n);                         // this question's exact answer beats any keyword
  const kw = m.keywords.get(n);
  if (!isAnswer && kw != null && kw < m.teams.length) return void teamJoin(uid, name, avatar, kw);
  if (!isAnswer && JOIN_WORDS.has(n)) return void teamJoin(uid, name, avatar);
  const p = m.players.get(uid);
  if (!p){                                                              // audience: their answers don't count; hint only when it looked like one
    addAudience(uid, name, avatar);
    if (asking && (isCorrect(text, round.set) || looksLikeAnswer(text, round.set))) nudge(uid + ':join', `${String(name).slice(0, 24)} ơi, gõ "tham gia" để câu trả lời được tính nhé!`, 120_000);
    return;
  }
  if (avatar && !p.avatar) p.avatar = avatar;
  if (!asking || round.answers.has(uid)) return;
  const correct = isCorrect(text, round.set);
  if (!correct && !looksLikeAnswer(text, round.set)) return;           // chat, not an answer: don't cost a step
  round.answers.set(uid, correct);
  if (correct) round.nCorrect++;
  else if (settings.showGuesses && n.length <= 30) broadcast({ t:'guess', name: String(name).slice(0, 24), text });
  broadcast({ t:'tcount', answered: round.answers.size, correct: round.nCorrect });
}

function endTeamRound(){
  const moves = match.apply([...round.answers].map(([uid, correct]) => ({ uid, correct })), settings.wrongStepDown);
  const up = moves.filter(x => x.to > x.from).length, down = moves.filter(x => x.to < x.from).length;
  lastReveal = { t:'reveal', ...publicQ(round), a: round.q.a, winners: [], totalCorrect: round.nCorrect, tried: round.answers.size, team: true };
  broadcast(lastReveal);
  broadcast({ t:'climb', moves, teams: match.stats() });
  say(`Câu trả lời đúng là, ${round.q.a}. ` + (round.nCorrect ? `${round.nCorrect} người leo lên một bậc` : 'Chưa ai trả lời đúng') + (down ? `, ${down} người bị tụt.` : '.'), { tag: 'reveal' });
  addLog(`✅ Đáp án: ${round.q.a} · ${up} người lên bậc, ${down} người tụt / ${round.answers.size} người trả lời`);
  setPhase('reveal', settings.revealSec * 1000, () => { round = null; running ? startRound() : setPhase('idle'); });
}

function endMatch(){
  const st = match.standings(), mvp = match.mvp(), w = st[0], played = st.some(t => t.active);
  lastMatchEnd = { t:'matchEnd', no: match.no, standings: st, mvp, nextAt: Date.now() + settings.breakSec * 1000, now: Date.now() };
  broadcast(lastMatchEnd);
  say(played ? `Hết giờ! Đội ${w.name} chiến thắng, trung bình ${String(w.avg).replace('.', ' phẩy ')} bậc.${mvp ? ` Leo cao nhất là ${spoken(mvp.name)}.` : ''} Trận mới bắt đầu sau ${settings.breakSec} giây.`
    : `Hết trận ${match.no}. Trận mới bắt đầu sau ${settings.breakSec} giây.`, { tag: 'match' });
  addLog(`🏆 Hết trận ${match.no}: ` + st.map(t => `${t.name} ${t.avg} (${t.active}/${t.members} người)`).join(' · ') + (mvp ? ` · MVP ${mvp.name} bậc ${mvp.step}` : ''));
  match = match.next(); match.steps = settings.stairSteps; match.max = settings.teamMax; match.setTeams(teamNames(), settings.teamCount);   // settings changed mid-match apply now
  setPhase('break', settings.breakSec * 1000, () => {
    lastMatchEnd = null; broadcastTeams();
    if (!running) return setPhase('idle');
    match.ready() ? startRound(true) : enterLobby();                     // same players still here: no need to wait in the lobby again
  });
}

// Lobby: wait until every team has someone, then count down `lobbySec`. Losing a team's last player pauses the countdown.
let lobbyTimer = null, lobbyAt = 0;
function lobbyState(){ const m = ensureMatch(); return { t:'lobby', no: m.no, teams: m.stats(), empty: m.empty().map(t => t.name), startsAt: lobbyAt, now: Date.now() }; }
function enterLobby(){
  setPhase('lobby'); clearTimeout(lobbyTimer); lobbyTimer = null; lobbyAt = 0;
  const m = ensureMatch(), names = m.teams.map(t => t.name).join(', ');
  addLog(`🚪 Phòng chờ trận ${m.no}: mỗi đội cần ít nhất 1 người`);
  say(`Phòng chờ trận ${m.no}. Gõ tham gia, hoặc gõ tên đội: ${names}, để vào đội. Mỗi đội cần ít nhất một người là bắt đầu.`, { tag: 'lobby' });
  lobbyCheck();
}
function lobbyCheck(){
  if (phase !== 'lobby') return;
  const ready = ensureMatch().ready();
  if (ready && !lobbyTimer){
    lobbyAt = Date.now() + settings.lobbySec * 1000;
    lobbyTimer = setTimeout(() => { lobbyTimer = null; lobbyAt = 0; if (phase === 'lobby' && running && match.ready()) startRound(true); else lobbyCheck(); }, settings.lobbySec * 1000);
    addLog(`⏳ Đủ người, bắt đầu sau ${settings.lobbySec} giây`);
  } else if (!ready && lobbyTimer){ clearTimeout(lobbyTimer); lobbyTimer = null; lobbyAt = 0; addLog('⏸ Một đội đang trống, tạm dừng đếm ngược'); }
  broadcast(lobbyState());
}

/* ---------------------------------------------------------------- chat */
// "/chat đội bạn gà lắm" → speech bubble over the player. Rate-limited per person, swear words masked, links removed, never read aloud.
const lastChat = new Map();
function onChatCmd(uid, name, avatar, raw){
  if (!settings.chatEnabled) return;
  const now = Date.now(); if (now - (lastChat.get(uid) || 0) < settings.chatCooldownSec * 1000) return;
  const text = cleanChat(raw); if (!text) return;
  lastChat.set(uid, now); if (lastChat.size > 5000) lastChat.clear();
  const p = teamMode() ? match?.players.get(uid) : null, team = p ? match.teams[p.team] : null;
  if (teamMode() && !p) addAudience(uid, name, avatar);
  broadcast({ t:'chat', uid, name: String(name).slice(0, 24), avatar: avatar || p?.avatar || '', text, team: team && { id: team.id, name: team.name, color: team.color } });
  addLog(`💬 ${name}${team ? ` [${team.name}]` : ''}: ${text}`);
}

let lastReveal = null;
function endRound(){
  if (!round) return;
  clearTimeout(hintTimer);
  if (round.team && match) return endTeamRound();
  const winners = round.correct.slice(0, 5);
  lastReveal = { t:'reveal', ...publicQ(round), a: round.q.a, winners, totalCorrect: round.correct.length, tried: round.tried.size };
  broadcast(lastReveal);
  const w = round.correct[0];
  say(`Câu trả lời đúng là, ${round.q.a}. ` + (w ? `Nhanh nhất là ${spoken(w.name)}${round.correct.length > 1 ? `, cùng ${round.correct.length - 1} người nữa` : ''}.` : 'Chưa ai trả lời đúng.'), { tag: 'reveal' });
  addLog(`✅ Đáp án: ${round.q.a} · ${round.correct.length} người đúng / ${round.tried.size} người trả lời` + (tiktok ? ` · ${liveHeard - round.heardAt} bình luận từ live` : ' · chưa kết nối TikTok'));
  setPhase('reveal', settings.revealSec * 1000, () => {
    broadcast({ t:'leaderboard', top: top() });
    setPhase('board', settings.gapSec * 1000, () => { round = null; running ? startRound() : setPhase('idle'); });
  });
}

function startGame(){ if (running) return; running = true; addLog('▶️ Bắt đầu đố vui'); broadcast({ t:'running', on: true }); if (phase === 'idle') startRound(); }
function stopGame(){
  running = false; addLog('⏸ Dừng sau câu này'); broadcast({ t:'running', on: false });
  if (phase === 'lobby'){ clearTimeout(lobbyTimer); lobbyTimer = null; lobbyAt = 0; }
  if (phase === 'loading' || phase === 'idle' || phase === 'lobby'){ setPhase('idle'); broadcast({ t:'idle' }); }
}
function skipQuestion(){ if (phase === 'question') endRound(); }

/* --------------------------------------------------------------- gifts */
function onGift(uid, name, giftName, count, diamonds, avatar){
  if (!uid) return;
  giftName = String(giftName || 'quà').slice(0, 30); count = clamp(count, 1, 9999);
  const coins = Math.max(1, (+diamonds || 1) * count), p = player(uid, name, avatar);
  p.coins += coins;
  const x = coins >= 99 ? 3 : 2, prev = boosts.get(uid), boostOn = settings.giftBoost && !teamMode();   // team mode: gifts are effects only
  if (boostOn) boosts.set(uid, { until: Math.max(prev?.until || 0, Date.now()) + 10 * 60_000, x: Math.max(x, prev && prev.until > Date.now() ? prev.x : 0) });
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const team = teamMode() && match?.players.get(uid) ? match.teams[match.players.get(uid).team] : null;
  broadcast({ t:'gift', name: p.name, avatar: p.avatar, giftName, count, coins, tier, boost: boostOn ? boosts.get(uid).x : 0, team: team && { name: team.name, color: team.color } });
  say(`Cảm ơn ${spoken(p.name)}${team ? ` đội ${team.name}` : ''} đã tặng ${giftName}${count > 1 ? ' ' + count + ' lần' : ''}.${boostOn ? ` Điểm nhân ${boosts.get(uid).x} trong 10 phút!` : ''}`, { tag: 'gift' });
  saveBoard();
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'bạn';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
function say(text, meta = {}){
  if (meta.tag === 'question') for (let i = ttsQueue.length - 1; i >= 0; i--) if (ttsQueue[i].meta.tag !== 'gift') ttsQueue.splice(i, 1);   // a new question beats stale lines
  if (ttsQueue.length >= 10){ addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; }
  ttsQueue.push({ text: String(text).slice(0, 400), meta }); pumpTTS();
}
async function synth(text){
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => {                                    // never let a stuck stream block the queue
      const to = setTimeout(() => rej(new Error('quá 15 giây')), 15_000);
      audioStream.on('data', c => chunks.push(c)); audioStream.on('close', () => { clearTimeout(to); res(); }); audioStream.on('error', e => { clearTimeout(to); rej(e); });
    });
    if (!chunks.length) throw new Error('không có âm thanh');
    return Buffer.concat(chunks);
  } finally { try { tts.close(); } catch {} }
}
// Edge's service sometimes drops a request with no audio, more often for some phrasings. Retry, nudging the punctuation.
const TTS_VARIANTS = [t => t, t => t.replace(/(\p{L})\. /gu, '$1, '), t => t.replace(/[.:]/g, ',') + '.'];
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  let audio = null, err = null;
  for (let i = 0; i < TTS_VARIANTS.length && !audio; i++){
    if (i) await new Promise(r => setTimeout(r, 600 * i));
    if (meta.tag === 'question' && meta.no !== roundNo) break;           // question already gone, don't read it late
    try { audio = await synth(TTS_VARIANTS[i](text)); } catch (e) { err = e; }
  }
  if (audio){
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    fs.writeFileSync(path.join(TTS_DIR, file), audio);
    broadcast({ t:'tts', url: `/tts/${file}`, tag: meta.tag });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
  } else if (err) addLog('TTS lỗi: ' + (err?.message || err).slice(0, 80));
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

/* --------------------------------------------------------------- TikTok */
let liveHeard = 0;                                                   // TikTok comments received since start, for the reveal log line
let tiktok = null, tiktokState ={ status: 'idle', uniqueId: '', error: '' }, TikTokLib = null, connecting = 0;
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/[/?].*$/, '').slice(0, 40);
  if (!uniqueId) return;
  const my = ++connecting;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    // enableExtendedGiftInfo needs a paid Euler Stream plan; giftDetails on each gift already carries name + diamonds.
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: false, processInitialData: false });
    // 2.x emits raw v3 protos (user.displayId, chat.content, gift.gift.*, like.count); the old 1.x names are kept as fallbacks.
    const av = u => u?.avatarThumb?.urlList?.[0] || u?.profilePicture?.urlList?.[0] || u?.profilePicture?.url?.[0] || u?.avatarThumb?.url?.[0] || '';
    const nm = u => u?.nickname || u?.displayId || u?.uniqueId || 'ẩn danh';
    const id = u => u?.displayId || u?.uniqueId || u?.id || u?.userId;
    conn.on(WebcastEvent.CHAT, d => {
      const text = d.content ?? d.comment;
      if (!liveHeard++) addLog(`💬 Đã nhận bình luận đầu tiên: ${nm(d.user)}: ${String(text).slice(0, 40)}`);   // proves comments reach the server
      onAnswer(id(d.user), nm(d.user), text, av(d.user));
    });
    conn.on(WebcastEvent.GIFT, d => {
      const type = d.gift?.type ?? d.giftDetails?.giftType;
      if (type === 1 && !d.repeatEnd) return;                       // streak still running
      const gname = d.gift?.name || d.giftDetails?.giftName || 'quà';
      const dia = d.gift?.diamondCount ?? d.giftDetails?.diamondCount ?? 1;
      onGift(id(d.user), nm(d.user), gname, d.repeatCount || 1, dia, av(d.user));
      addLog(`🎁 ${nm(d.user)} tặng ${gname} x${d.repeatCount || 1}`);
    });
    conn.on(WebcastEvent.LIKE,d => broadcast({ t:'like', n: Math.min(10, d.count || d.likeCount || 1) }));
    conn.on(ControlEvent.DISCONNECTED, () => { if (tiktok !== conn) return; tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    if (my !== connecting){ try { await conn.disconnect(); } catch {} return; }  // a newer connect superseded this one
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    if (my !== connecting) return;
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){ const c = tiktok; tiktok = null; if (c){ try { await c.disconnect(); } catch {} } tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState }); }

/* ----------------------------------------------------------------- bots */
// Simulated viewers for testing without going live. They answer right ~40% of the time.
const BOT_NAMES = ['Minh An', 'Thu Hà', 'Quang Huy', 'Bảo Ngọc', 'Hải Đăng', 'Mai Anh', 'Đức Anh', 'Phương Thảo', 'Trung Kiên', 'Ngọc Lan', 'Tuấn Kiệt', 'Diệu Linh', 'Hoàng Nam', 'Khánh Vy', 'Gia Bảo'];
const BOT_WRONG = ['hà nội', 'con mèo', 'không biết', '5', 'mặt trời', 'huế', 'cái bàn', 'phở', 'nước', 'con gà', '12', 'sài gòn'];
const BOT_CHAT = ['đội bạn gà lắm 🐔', 'cố lên đội mình ơi!', 'câu này dễ mà 😎', 'sắp lên đỉnh rồi', 'đừng có chép bài nha', 'vô địch là đây 🏆', 'ủa sao khó vậy 😭'];
const botName = i => BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? ' ' + (i + 1) : '') + ' ·bot';
let bots = 0, botTimers = [];
// Team mode: bots join the way viewers do, by typing "tham gia" or a team name, spread over a few seconds.
function botsJoin(){
  if (!teamMode() || !bots) return;
  const m = ensureMatch();
  for (let i = 0; i < bots; i++) if (!m.players.get('bot_' + i)) setTimeout(() => {
    if (!bots || i >= bots || !teamMode()) return;
    onAnswer('bot_' + i, botName(i), Math.random() < .5 ? 'tham gia' : m.teams[Math.floor(Math.random() * m.teams.length)].name);
  }, 500 + Math.random() * 6000);
}
function botsRound(){
  for (const t of botTimers) clearTimeout(t); botTimers = [];
  if (!bots || !round) return;
  const r = round, len = r.endsAt - r.startedAt;
  for (let i = 0; i < bots; i++){
    const name = botName(i);
    const skill = r.team ? .45 + (i % 5) * .1 : .4;                    // team mode: some bots are better, so teams pull apart
    if (r.team && Math.random() < .1) botTimers.push(setTimeout(() => onAnswer('bot_' + i, name, ['hay quá', 'chào cả nhà', 'khó quá', 'haha'][i % 4]), 1500));
    if (Math.random() < .06) botTimers.push(setTimeout(() => onAnswer('bot_' + i, name, '/chat ' + BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)]), 1000 + Math.random() * len * .8));
    const tries = r.team ? 1 : 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < tries; k++) botTimers.push(setTimeout(() => {
      if (round !== r) return;
      const right = Math.random() < skill, a = right ? (Math.random() < .5 ? norm(r.q.a) : r.q.a) : BOT_WRONG[Math.floor(Math.random() * BOT_WRONG.length)];
      onAnswer('bot_' + i, name, a);
      if (Math.random() < .15) broadcast({ t:'like', n: 1 + Math.floor(Math.random() * 3) });
    }, 2500 + Math.random() * len * .85));
  }
  if (Math.random() < .12){ const i = Math.floor(Math.random() * bots); botTimers.push(setTimeout(() => onGift('bot_' + i, botName(i), 'Hoa hồng', 1 + Math.floor(Math.random() * 5), 1), 4000)); }
}

/* -------------------------------------------------------------- control */
function onControl(m){
  switch (m.cmd){
    case 'start': startGame(); break;
    case 'stop': stopGame(); break;
    case 'skip': skipQuestion(); break;
    case 'reload': loadBank(); break;
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': connecting++; disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'answer': { const n = String(m.name || 'Khách').slice(0, 24); onAnswer('sim_' + norm(n), n, m.text); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 24); onGift('sim_' + norm(n), n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'bots': bots = m.on ? clamp(m.n, 1, 60) : 0; addLog(bots ? `🤖 Bật ${bots} bot trả lời` : '🤖 Tắt bot'); broadcast({ t:'bots', n: bots }, 'control'); botsJoin(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 300), { tag: 'say' }); break;
    case 'resetScores': board = { day: today(), players: {} }; boosts.clear(); saveBoard(); addLog('🧹 Đã xóa bảng điểm hôm nay'); break;
    case 'resetHistory': history.clear(); saveJSON('history.json', {}); addLog('🧹 Đã xóa lịch sử câu đã hỏi'); broadcastBank(); break;
    case 'geminiTest': if (!GEMINI_KEY) addLog('🤖 Chưa có GEMINI_API_KEY trong file .env'); else { geminiFailAt = 0; geminiFill(); } break;
    case 'endMatch': if (match?.startedAt){ match.endsAt = Date.now(); addLog('🏁 Trận sẽ kết thúc sau câu này'); broadcastTeams(); } break;
    case 'clearTeams': match = null; ensureMatch(); broadcastTeams(); addLog('🧹 Đã xóa danh sách đội, trận mới bắt đầu từ đầu'); lobbyCheck(); botsJoin(); break;
    case 'settings': {
      const prevUrl = settings.sheetUrl, prevMode = settings.mode;
      applySettings(m.settings || {}); saveJSON('settings.json', settings);
      broadcast({ t:'settings', settings: publicSettings() });
      if (settings.sheetUrl !== prevUrl) loadBank(); else broadcastBank();
      if (match) match.max = settings.teamMax;
      if (match && !match.startedAt){ match.steps = settings.stairSteps; match.setTeams(teamNames(), settings.teamCount); }   // not started yet: apply now
      else if (match) match.setTeams(teamNames(), match.teams.length);                                                      // running: rename only
      if (teamMode()){ ensureMatch(); broadcastTeams(); lobbyCheck(); botsJoin(); }
      if (prevMode !== settings.mode) addLog(`🔁 Chế độ: ${teamMode() ? 'Đội leo bậc' : 'Cá nhân'} (áp dụng từ câu sau)`);
      break;
    }
  }
}
const publicSettings = () => ({ ...settings });

/* ------------------------------------------------------------- server */
// Same safety model as the temple kit: localhost only, Host + Origin checks, static whitelist, overlays can't send commands.
// HOST=0.0.0.0 in .env opens the overlay to the LAN (e.g. a Windows PC running LIVE Studio); the control panel stays localhost-only.
const HOST = process.env.HOST || '127.0.0.1';
const LAN = !/^(127\.|localhost$|::1$)/.test(HOST);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.wav':'audio/wav', '.woff2':'font/woff2' };
const LOCAL_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];
// This machine's own LAN addresses, re-read each time so a new DHCP lease still works. Other names stay rejected (DNS rebinding).
const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const okHost = h => { h = String(h || '').toLowerCase(); return LOCAL_HOSTS.includes(h) || (LAN && lanIPs().some(ip => h === `${ip}:${PORT}`)); };
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const ROUTES = { '/': path.join(PUBLIC, 'control.html'), '/overlay': path.join(PUBLIC, 'overlay.html') };
function resolveStatic(p){
  if (ROUTES[p]) return ROUTES[p];
  const m = p.match(/^\/(static|assets|tts)\/(.+)$/); if (!m) return null;
  if (m[2].split('/').some(seg => !seg || seg.startsWith('.'))) return null;
  if (!MIME[path.extname(m[2]).toLowerCase()]) return null;                  // only media / page types, never data or code files
  const base = { static: PUBLIC, assets: ASSETS, tts: TTS_DIR }[m[1]];
  const file = path.normalize(path.join(base, m[2]));
  return file.startsWith(base + path.sep) ? file : null;
}
// Optional files the streamer can drop into assets/: bg.(jpg|png|webp), logo.png, host.png, music/*.mp3
function assetInfo(){
  const has = f => fs.existsSync(path.join(ASSETS, f));
  const pick = (...fs_) => fs_.find(has) || '';
  let music = []; try { music = fs.readdirSync(path.join(ASSETS, 'music')).filter(f => /\.(mp3|ogg|m4a)$/i.test(f) && !f.startsWith('.')).map(f => '/assets/music/' + encodeURIComponent(f)); } catch {}
  const u = f => f ? '/assets/' + f : '';
  const per = base => [1, 2, 3].map(i => u(pick(`${base}${i}.png`, `${base}${i}.webp`)));     // team1.png, step1.png, char1.png… one per team
  return { bg: u(pick('bg.jpg', 'bg.png', 'bg.webp')), logo: u(pick('logo.png', 'logo.webp')), host: u(pick('host.png', 'host.webp')), music,
    goal: u(pick('goal.png', 'goal.webp')), team: per('team'), step: per('step'), char: per('char') };
}
// Everything a freshly (re)loaded overlay needs to draw the current moment, not just the next event.
function snapshot(){
  const q = round && phase === 'question';
  return { t:'state', settings: publicSettings(), running, phase, round: q ? publicQ(round) : null,
    correct: q ? round.correct.map((c, rank) => ({ rank, name: c.name, avatar: c.avatar, points: c.points, x: c.x })) : [],
    reveal: phase === 'reveal' ? lastReveal : null, top: top(), assets: assetInfo(), tiktok: tiktokState, now: Date.now(),
    match: teamMode() ? ensureMatch().public() : null, matchEnd: phase === 'break' ? lastMatchEnd : null,
    tcount: round?.team && phase === 'question' ? { answered: round.answers.size, correct: round.nCorrect } : null,
    lobby: phase === 'lobby' ? lobbyState() : null, audience: teamMode() ? audList() : [] };
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (p === '/' && !isLocal(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bảng điều khiển chỉ mở trên máy chạy server. Máy khác mở /overlay.'); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': p.startsWith('/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (new URL(req.url, 'http://x').searchParams.get('role') === 'control' && !isLocal(req)) return false;
    if (!origin) return true;                                  // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control'){
    ws.send(JSON.stringify({ t:'logs', lines: log }));
    ws.send(JSON.stringify({ t:'bank', ...bankStats() }));
    ws.send(JSON.stringify({ t:'bots', n: bots }));
    if (round && phase === 'question') ws.send(JSON.stringify({ t:'host', no: round.no, q: round.q.q, a: round.q.a, alt: round.q.alt, source: round.q.source, row: round.q.row || null }));
  }
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});

await loadBank();
server.listen(PORT, HOST, () => {
  addLog(`Server chạy · Bảng điều khiển: http://localhost:${PORT}  ·  Overlay: http://localhost:${PORT}/overlay  ·  Gemini: ${GEMINI_KEY ? GEMINI_MODEL : 'chưa có key'}`);
  if (LAN) addLog(`Mở cho mạng LAN · Overlay từ máy khác: ${lanIPs().map(ip => `http://${ip}:${PORT}/overlay`).join('  ') || '(chưa có mạng)'}`);
});
