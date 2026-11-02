// Pure helpers (no I/O): answer matching, CSV parsing, Google Sheet URLs, hints. Covered by test.mjs.
import crypto from 'node:crypto';

/* ------------------------------------------------------------ answers */
// "Đà Nẵng!!" → "da nang". Viewers type fast: no diacritics, random case, punctuation.
export function norm(s){
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const GUESS_FILLERS = /^(dap an la|dap an|la|da|chac la|toi doan|minh doan)\s+/;
const ANSWER_FILLERS = /^(con|cai|qua|trai|cay|chiec|tinh|thanh pho|tp)\s+/;

// All accepted forms of one question's answer, normalized.
export function answerSet(answer, alts = []){
  const set = new Set();
  for (const a of [answer, ...alts]){ const n = norm(a); if (!n) continue; set.add(n); set.add(n.replace(/\s+/g, '')); const m = n.replace(ANSWER_FILLERS, ''); if (m) set.add(m); }
  return set;
}

export function lev(a, b){
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}

// Exact match after normalizing; one typo allowed on answers of 6+ letters (not on numbers).
export function isCorrect(guess, set){
  let g = norm(guess); if (!g) return false;
  const forms = [g, g.replace(GUESS_FILLERS, '')]; forms.push(forms[1].replace(/\s+/g, ''));
  for (const f of forms) if (set.has(f)) return true;
  for (const a of set){ if (a.length < 6 || /\d/.test(a)) continue; for (const f of forms) if (lev(f, a) <= 1) return true; }
  return false;
}

// "Đà Nẵng" → "Đ _   N _ _ _"
export function autoHint(answer){
  return String(answer).trim().split(/\s+/).map(w => [...w].map((c, i) => i === 0 ? c.toUpperCase() : '_').join(' ')).join('   ');
}

/* --------------------------------------------------------------- chat */
// "/chat đội bạn gà lắm", "/c ...", "!chat ..." → "đội bạn gà lắm"; anything else → null
export function parseChat(text){ const m = String(text ?? '').match(/^\s*[/!](?:chat|c)\s+(.+)$/is); return m ? m[1] : null; }

// Swear words. Abbreviations are unambiguous even without diacritics; full words only match WITH diacritics,
// because "lon", "cac", "buoi", "deo" are also ordinary words (lớn, các, buổi, đeo).
const BAD_NORM = new Set(['dm', 'dmm', 'dcm', 'dkm', 'dcmm', 'vl', 'vcl', 'vkl', 'vcc', 'vlz', 'cl', 'clm', 'clgt', 'cc', 'cmm', 'ml', 'loz', 'fuck', 'fck', 'fucking', 'shit', 'bitch', 'dit', 'djt', 'dume', 'duma']);
const BAD_RAW = new Set(['đéo', 'đếch', 'địt', 'đụ', 'đĩ', 'điếm', 'lồn', 'cặc', 'buồi', 'đù', 'đờ', 'mẹ mày', 'má mày', 'đjt', 'cứt']);
export function cleanChat(s, max = 60){
  let t = String(s ?? '').normalize('NFC').replace(/https?:\/\/\S+|www\.\S+|\S+\.(?:com|net|vn|org|io|me|ly|xyz)\b\S*/gi, ' ')
    .replace(/[\u0000-\u001f​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
  let bad = 0;
  t = t.replace(/(m[ẹá] mày)/giu, () => { bad++; return '***'; });
  t = t.split(' ').map(w => { const raw = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); if (BAD_RAW.has(raw) || BAD_NORM.has(norm(w).replace(/\s+/g, ''))){ bad++; return '***'; } return w; }).join(' ');
  t = [...t].slice(0, max).join('').trim();
  if (!t.replace(/[*\s\p{P}\p{S}]/gu, '')) return '';                    // nothing left but stars and emoji-free punctuation
  return t;
}

/* ---------------------------------------------------------------- CSV */
export function parseCSV(text){
  const rows = []; let row = [], f = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){ if (c === '"'){ if (text[i+1] === '"'){ f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ','){ row.push(f); f = ''; }
    else if (c === '\n'){ row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// Header names in Vietnamese (with or without diacritics) or English.
const COLS = {
  q: ['cau hoi', 'question', 'q'], a: ['dap an', 'answer', 'a'], alt: ['dap an khac', 'alt', 'alts', 'dap an phu'],
  topic: ['chu de', 'topic'], level: ['do kho', 'level'], hint: ['goi y', 'hint'], on: ['bat', 'dung', 'enabled', 'on'],
};
const OFF = new Set(['0', 'khong', 'false', 'no', 'tat', 'x', 'n']);
export const qid = text => crypto.createHash('sha1').update(norm(text)).digest('hex').slice(0, 12);

export function questionsFromCSV(text){
  const rows = parseCSV(text); if (!rows.length) return { questions: [], errors: ['Sheet trống'] };
  const head = rows[0].map(norm), idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex(h => names.includes(h));
  if (idx.q < 0 || idx.a < 0) return { questions: [], errors: ['Không thấy cột "Câu hỏi" và "Đáp án" ở dòng đầu'] };
  const questions = [], errors = [], seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const cell = k => idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '';
    const q = cell('q'), a = cell('a');
    if (!q && !a) return;
    if (!q || !a){ errors.push(`Dòng ${i + 2}: thiếu câu hỏi hoặc đáp án`); return; }
    if (OFF.has(norm(cell('on')))) return;
    const id = qid(q); if (seen.has(id)){ errors.push(`Dòng ${i + 2}: trùng câu hỏi`); return; } seen.add(id);
    questions.push(clean({ id, q, a, alt: cell('alt').split(/[|;]/), topic: cell('topic'), level: +cell('level') || 1, hint: cell('hint'), row: i + 2 }));
  });
  return { questions, errors };
}

export function clean(x){
  return { id: x.id || qid(x.q), q: String(x.q).trim().slice(0, 220), a: String(x.a).trim().slice(0, 60),
    alt: (x.alt || []).map(s => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 12),
    topic: String(x.topic || '').trim().slice(0, 30), level: Math.max(1, Math.min(3, Math.round(+x.level || 1))),
    hint: String(x.hint || '').trim().slice(0, 80), row: x.row };
}

/* ------------------------------------------------------- Google Sheet */
// Accepts the normal share link, a "publish to web" CSV link, or an export link → CSV download URL.
export function sheetCsvUrl(u){
  u = String(u || '').trim(); if (!u) return '';
  let url; try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  if (/\/pub$/.test(url.pathname) || url.searchParams.get('output') === 'csv' || url.searchParams.get('format') === 'csv') return url.href;
  const m = url.pathname.match(/\/spreadsheets\/d\/([\w-]+)/); if (!m) return null;
  const gid = url.searchParams.get('gid') || (url.hash.match(/gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

/* -------------------------------------------------------------- picking */
// Tier 1: first sheet question (in sheet order) not asked within cooldown. Returns null when all are recent.
export function pickFresh(list, history, cooldownMs, now = Date.now()){
  return list.find(q => now - (history.get(q.id) || 0) >= cooldownMs) || null;
}
// Fallback when Gemini fails: start the sheet over, i.e. the question asked longest ago.
export function pickOldest(list, history){
  let best = null, t = Infinity;
  for (const q of list){ const h = history.get(q.id) || 0; if (h < t){ t = h; best = q; } }
  return best;
}

// Gemini output → validated questions (short answers only: they must be typeable in a comment).
export function validateGemini(arr, knownIds = new Set()){
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr){
    const q = String(x?.cau_hoi || '').trim(), a = String(x?.dap_an || '').trim();
    if (q.length < 8 || !a || a.split(/\s+/).length > 4 || a.length > 40) continue;
    const c = clean({ q, a, alt: Array.isArray(x.dap_an_khac) ? x.dap_an_khac : [], topic: x.chu_de, hint: x.goi_y, level: x.do_kho });
    if (knownIds.has(c.id)) continue; knownIds.add(c.id); out.push(c);
  }
  return out;
}
