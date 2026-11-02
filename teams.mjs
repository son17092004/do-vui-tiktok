// Team ladder mode (no I/O): viewers join a team, each correct answer climbs one step, each wrong one drops a step.
// Teams are ranked by the AVERAGE step of members who have answered this match, so a crowded team doesn't win by size.
import { norm } from './core.mjs';

export const TEAM_COLORS = ['#ff4d6d', '#4dabff', '#ffc94a'];
export const DEFAULT_TEAM_NAMES = ['Đỏ', 'Xanh', 'Vàng'];

// "đỏ", "do", "đội đỏ", "1", "doi 1" → team index
export function teamKeywords(names){
  const map = new Map();
  names.forEach((n, i) => { for (const k of [norm(n), 'doi ' + norm(n), String(i + 1), 'doi ' + (i + 1)]) if (k && !map.has(k)) map.set(k, i); });
  return map;
}

// "tham gia", "vào", "join"… mean "put me in a team", never an answer.
export const JOIN_WORDS = new Set(['tham gia', 'thamgia', 'tg', 'vao', 'vao doi', 'xin vao doi', 'cho vao', 'cho vao doi', 'cho minh vao', 'cho em vao', 'cho toi vao', 'xin vao',
  'join', 'choi', 'choi voi', 'cho choi', 'cho minh choi', 'dang ky', 'dk']);

// Comments that are obviously chat, not an answer attempt. In team mode a wrong answer costs a step, so be generous here.
const CHAT = new Set(['hay', 'hay qua', 'hay qua di', 'chao', 'chao moi nguoi', 'chao ca nha', 'xin chao', 'hello', 'hi', 'alo', 'alo alo', 'haha', 'hihi', 'hehe', 'kk', 'kkk', 'kkkk',
  'ok', 'oke', 'okay', 'ua', 'uh', 'um', 'wow', 'hu hu', 'huhu', 'kho qua', 'de qua', 'kho', 'de', 'kho the', 'de the', 'sai roi', 'dung roi', 'thua', 'chiu', 'bo tay',
  'khong biet', 'ko biet', 'k biet', 'kb', 'hong biet', 'qua', 'next', 'tiep', 'nhanh len', 'cam on', 'thank', 'thanks', 'love', 'yeu', 'tha tim', 'like', 'follow', 'fl']);
export function looksLikeAnswer(text, answers){
  const n = norm(text);
  if (!n || CHAT.has(n)) return false;
  let longest = 0; for (const a of answers) longest = Math.max(longest, a.length);
  return n.length <= Math.max(14, longest * 2 + 4);                    // a whole sentence is chat, not an answer
}

export class TeamMatch {
  constructor({ names = DEFAULT_TEAM_NAMES, count = 2, steps = 12, max = 20, no = 1 } = {}){
    this.no = no; this.steps = steps; this.max = max; this.startedAt = 0; this.endsAt = 0;
    this.teams = []; this.players = new Map();
    this.setTeams(names, count);
  }
  setTeams(names, count){
    this.teams = Array.from({ length: count }, (_, i) => ({ id: i, name: String(names[i] || DEFAULT_TEAM_NAMES[i]).slice(0, 14), color: TEAM_COLORS[i] }));
    this.keywords = teamKeywords(this.teams.map(t => t.name));
    for (const p of this.players.values()) if (p.team >= count) p.team = this.smallest();
  }
  start(now, durationMs){ this.startedAt = now; this.endsAt = now + durationMs; }
  size(team){ let n = 0; for (const p of this.players.values()) if (p.team === team) n++; return n; }
  smallest(){ let best = 0; for (const t of this.teams) if (this.size(t.id) < this.size(best)) best = t.id; return best; }

  ready(){ return this.teams.every(t => this.size(t.id) >= 1); }        // a match needs someone in every team
  empty(){ return this.teams.filter(t => !this.size(t.id)); }

  full(team){ return this.size(team) >= this.max; }

  // team undefined → keep current team, or put a newcomer in the smallest team.
  // Anyone can join at any time while the team has room (`max`); a full team turns them away, they stay in the audience.
  // Before the match starts switching is free. During it: one switch, back to the bottom step, and the last member can't leave.
  join(uid, name, avatar, team){
    let p = this.players.get(uid);
    if (p){ if (name) p.name = String(name).slice(0, 24); if (avatar) p.avatar = avatar; }
    if (!p){
      if (team == null){ team = this.smallest(); if (this.full(team)) return { allFull: true }; }
      else if (this.full(team)) return { full: true, team };
      p = { uid, name: String(name || 'ẩn danh').slice(0, 24), avatar: avatar || '', team: team ?? this.smallest(), step: 0, active: false, switches: 0, upAt: 0, topAt: 0 };
      this.players.set(uid, p); return { p, joined: true };
    }
    if (team == null || team === p.team) return { p };
    if (this.full(team)) return { p, full: true, team };
    if (this.startedAt){
      if (p.switches >= 1) return { p, locked: true };
      if (this.size(p.team) <= 1) return { p, lastOne: true };
      p.switches++;
    }
    p.team = team; p.step = 0; p.upAt = 0; p.topAt = 0;
    return { p, switched: true };
  }

  // results: [{ uid, correct }] for one question → moves [{ uid, from, to }]
  apply(results, wrongDown, now = Date.now()){
    const moves = [];
    for (const { uid, correct } of results){
      const p = this.players.get(uid); if (!p) continue;
      p.active = true;
      const from = p.step;
      if (correct){ p.step = Math.min(this.steps, p.step + 1); if (p.step > from) p.upAt = now; if (p.step === this.steps && !p.topAt) p.topAt = now; }
      else if (wrongDown) p.step = Math.max(0, p.step - 1);
      moves.push({ uid, from, to: p.step, correct });
    }
    return moves;
  }

  stats(){
    return this.teams.map(t => {
      const ms = [...this.players.values()].filter(p => p.team === t.id), act = ms.filter(p => p.active);
      const avg = act.length ? act.reduce((s, p) => s + p.step, 0) / act.length : 0;
      return { ...t, members: ms.length, active: act.length, avg: Math.round(avg * 10) / 10, best: Math.max(0, ...ms.map(p => p.step)) };
    });
  }
  standings(){ return this.stats().sort((a, b) => b.avg - a.avg || b.active - a.active || a.id - b.id); }
  // Highest step; ties go to whoever got there first.
  mvp(){
    let best = null;
    for (const p of this.players.values()) if (p.active && p.step > 0 && (!best || p.step > best.step || (p.step === best.step && (p.topAt || p.upAt) < (best.topAt || best.upAt)))) best = p;
    return best && { uid: best.uid, name: best.name, avatar: best.avatar, team: best.team, step: best.step };
  }
  // Next match: same people in the same teams, back at the bottom.
  next(){
    const m = new TeamMatch({ names: this.teams.map(t => t.name), count: this.teams.length, steps: this.steps, max: this.max, no: this.no + 1 });
    for (const p of this.players.values()) m.players.set(p.uid, { ...p, step: 0, active: false, switches: 0, upAt: 0, topAt: 0 });
    return m;
  }
  publicPlayers(){ return [...this.players.values()].map(p => ({ uid: p.uid, name: p.name, avatar: p.avatar, team: p.team, step: p.step })); }
  public(){ return { no: this.no, steps: this.steps, max: this.max, startedAt: this.startedAt, endsAt: this.endsAt, teams: this.stats(), players: this.publicPlayers() }; }
}
