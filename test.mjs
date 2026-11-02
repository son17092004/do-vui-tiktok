// node test.mjs — checks answer matching, CSV/Sheet parsing and the two-tier question picking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { norm, answerSet, isCorrect, autoHint, parseCSV, questionsFromCSV, sheetCsvUrl, pickFresh, pickOldest, validateGemini, parseChat, cleanChat } from './core.mjs';
import { TeamMatch, teamKeywords, looksLikeAnswer, JOIN_WORDS } from './teams.mjs';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('✓', name); };

t('chuẩn hóa tiếng Việt', () => {
  assert.equal(norm('Đà Nẵng!!'), 'da nang');
  assert.equal(norm('  ĐÀ   NẴNG '), 'da nang');
  assert.equal(norm('Hồ Chí Minh.'), 'ho chi minh');
});

t('chấm đáp án', () => {
  const s = answerSet('Đà Nẵng');
  for (const g of ['Đà Nẵng', 'da nang', 'DA NANG', 'danang', 'là Đà Nẵng', 'đáp án là đà nẵng', 'da nag']) assert.ok(isCorrect(g, s), g);
  for (const g of ['Hà Nội', 'da', 'nang', '', 'đà nẵng hà nội huế']) assert.ok(!isCorrect(g, s), g);
  const hcm = answerSet('Hồ Chí Minh', ['Sài Gòn', 'TPHCM', 'SG']);
  for (const g of ['sai gon', 'tphcm', 'sg', 'Ho Chi Minh']) assert.ok(isCorrect(g, hcm), g);
  const cua = answerSet('con cua', ['cua']);
  assert.ok(isCorrect('cua', cua)); assert.ok(isCorrect('Con cua', cua));
  const num = answerSet('168');
  assert.ok(isCorrect('168', num)); assert.ok(!isCorrect('167', num), 'không cho sai số');
  const short = answerSet('gà');
  assert.ok(isCorrect('ga', short)); assert.ok(!isCorrect('gai', short), 'đáp án ngắn không cho sai chính tả');
});

t('gợi ý tự động', () => assert.equal(autoHint('Đà Nẵng'), 'Đ _   N _ _ _'));

t('đọc CSV có ngoặc kép, dấu phẩy, xuống dòng', () => {
  const r = parseCSV('a,b\n"x, y","he said ""hi"""\r\n"multi\nline",z\n');
  assert.deepEqual(r, [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
});

t('đọc Sheet: tiêu đề có hoặc không dấu, cột Bật, trùng câu', () => {
  const { questions, errors } = questionsFromCSV('Cau hoi,DAP AN,Đáp án khác,Bật\nA?,x,y|z,\nB?,w,,không\nA?,x,,\nC?,,,\n');
  assert.equal(questions.length, 1); assert.deepEqual(questions[0].alt, ['y', 'z']);
  assert.equal(errors.length, 2);
  assert.ok(questionsFromCSV('foo,bar\n1,2').errors[0].includes('Câu hỏi'));
});

t('file câu hỏi mẫu hợp lệ', () => {
  const { questions, errors } = questionsFromCSV(fs.readFileSync(new URL('./cau-hoi-mau.csv', import.meta.url), 'utf8'));
  assert.deepEqual(errors, []); assert.ok(questions.length >= 50, 'có ' + questions.length + ' câu');
  for (const q of questions) assert.ok(isCorrect(q.a, answerSet(q.a, q.alt)), q.q);
});

t('link Google Sheet → link CSV', () => {
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/AbC-123_x/edit?usp=sharing#gid=456'), 'https://docs.google.com/spreadsheets/d/AbC-123_x/export?format=csv&gid=456');
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/AbC/edit'), 'https://docs.google.com/spreadsheets/d/AbC/export?format=csv&gid=0');
  const pub = 'https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv';
  assert.equal(sheetCsvUrl(pub), pub);
  assert.equal(sheetCsvUrl('https://evil.example.com/spreadsheets/d/x'), null);
  assert.equal(sheetCsvUrl('http://docs.google.com/spreadsheets/d/x'), null);
  assert.equal(sheetCsvUrl(''), '');
});

t('tầng 1: theo thứ tự Sheet, bỏ câu đã hỏi trong 2 giờ', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }], now = 10 * 3600e3, H2 = 2 * 3600e3;
  const h = new Map([['a', now - 60e3], ['b', now - 3 * 3600e3]]);
  assert.equal(pickFresh(list, h, H2, now).id, 'b', 'b đã quá 2 giờ nên hỏi lại được');
  h.set('b', now); assert.equal(pickFresh(list, h, H2, now).id, 'c');
  h.set('c', now); assert.equal(pickFresh(list, h, H2, now), null, 'hết câu mới → sang Gemini');
  assert.equal(pickOldest(list, h).id, 'a', 'Gemini lỗi → quay lại câu hỏi lâu nhất');
});

t('kiểm tra câu do Gemini tạo', () => {
  const known = new Set();
  const out = validateGemini([
    { cau_hoi: 'Thủ đô của Nhật Bản là gì?', dap_an: 'Tokyo', dap_an_khac: ['Tô-ky-ô'] },
    { cau_hoi: 'Thủ đô của Nhật Bản là gì?', dap_an: 'Tokyo' },                       // trùng
    { cau_hoi: 'Ngắn?', dap_an: 'x' },                                                // câu quá ngắn
    { cau_hoi: 'Giải thích vì sao bầu trời màu xanh?', dap_an: 'do tán xạ ánh sáng mặt trời trong khí quyển' },
    { cau_hoi: 'Thiếu đáp án ở đây nhé?' },
  ], known);
  assert.equal(out.length, 1); assert.equal(out[0].a, 'Tokyo');
  assert.deepEqual(validateGemini('not an array'), []);
});

t('đội: từ khóa đổi đội', () => {
  const k = teamKeywords(['Đỏ', 'Xanh', 'Vàng']);
  assert.equal(k.get(norm('đỏ')), 0); assert.equal(k.get(norm('Đội Xanh')), 1); assert.equal(k.get('3'), 2); assert.equal(k.get('doi 2'), 1);
  assert.equal(k.get(norm('tím')), undefined);
});

t('đội: lọc chuyện phiếm khỏi câu trả lời sai', () => {
  const s = answerSet('Đà Nẵng');
  for (const c of ['hay quá', 'Chào mọi người!!', 'haha', '❤️❤️', 'không biết', 'câu này khó quá mọi người ơi ai biết không']) assert.ok(!looksLikeAnswer(c, s), c);
  for (const c of ['Hà Nội', 'huế', 'sài gòn', 'da lat']) assert.ok(looksLikeAnswer(c, s), c);
  for (const c of ['Tham gia', 'vào', 'cho mình vào', 'JOIN']) assert.ok(JOIN_WORDS.has(norm(c)), 'từ xin vào đội: ' + c);
});

t('đội: vào đội ít người nhất, đổi đội 1 lần và về bậc 0', () => {
  const m = new TeamMatch({ count: 3, steps: 5 });
  assert.equal(m.join('a', 'A').p.team, 0); assert.equal(m.join('b', 'B').p.team, 1); assert.equal(m.join('c', 'C').p.team, 2);
  assert.equal(m.join('d', 'D').p.team, 0);
  assert.ok(m.join('d', 'D', '', 2).switched && m.join('d', 'D', '', 1).switched && m.join('d', 'D', '', 0).switched, 'trước trận đổi tự do');
  m.start(1000, 60e3);
  m.apply([{ uid: 'a', correct: true }, { uid: 'a', correct: true }], true);
  assert.equal(m.players.get('a').step, 2);
  assert.ok(m.join('c', 'C', '', 0).lastOne, 'người cuối cùng của đội không được bỏ đội');
  const sw = m.join('a', 'A', '', 1); assert.ok(sw.switched); assert.equal(sw.p.step, 0, 'đổi đội thì về chân cầu thang');
  assert.ok(m.join('a', 'A', '', 2).locked, 'mỗi trận chỉ đổi 1 lần');
  assert.ok(!m.join('a', 'A').locked, 'bình luận thường không bị coi là đổi đội');
});

t('đội: cần mỗi đội ít nhất 1 người mới bắt đầu', () => {
  const m = new TeamMatch({ count: 2 });
  assert.ok(!m.ready()); m.join('a', 'A', '', 0); assert.ok(!m.ready()); assert.deepEqual(m.empty().map(t => t.id), [1]);
  m.join('b', 'B'); assert.ok(m.ready(), 'người gõ "tham gia" vào đội đang trống');
});

t('đội: giới hạn số người, đầy thì ở khán đài', () => {
  const m = new TeamMatch({ count: 2, max: 2 });
  m.join('a', 'A', '', 0); m.join('b', 'B', '', 0);
  assert.ok(m.join('c', 'C', '', 0).full, 'đội Đỏ đủ 2 người');
  assert.equal(m.join('c', 'C').p.team, 1, '"tham gia" vào đội còn chỗ'); m.join('d', 'D');
  assert.ok(m.join('e', 'E').allFull, 'tất cả đều đủ'); assert.ok(!m.players.has('e'));
  m.start(1000, 60e3);
  assert.ok(m.join('x', 'X').allFull);
  assert.ok(m.join('a', 'A', '', 1).full, 'không đổi sang đội đã đủ');
  const n = new TeamMatch({ count: 2, max: 3 }); n.join('a', 'A', '', 0); n.join('b', 'B', '', 1); n.start(1000, 60e3);
  const late = n.join('z', 'Z'); assert.ok(late.joined); assert.equal(late.p.step, 0, 'vào giữa trận bắt đầu từ bậc 0');
});

t('chat: lệnh /chat và lọc từ tục', () => {
  assert.equal(parseChat('/chat đội bạn gà lắm'), 'đội bạn gà lắm');
  assert.equal(parseChat('!c Đỏ vô địch'), 'Đỏ vô địch');
  assert.equal(parseChat('chat đội bạn'), null); assert.equal(parseChat('/chat'), null);
  assert.equal(cleanChat('đội bạn gà lắm'), 'đội bạn gà lắm');
  assert.equal(cleanChat('vcl đội bạn gà'), '*** đội bạn gà');
  assert.equal(cleanChat('Đội lớn các buổi đeo'), 'Đội lớn các buổi đeo', 'không chặn nhầm từ thường');
  assert.equal(cleanChat('xem tại https://x.com/abc nhé'), 'xem tại nhé');
  assert.equal(cleanChat('dm vcl'), '', 'chỉ còn *** thì bỏ');
  assert.equal(cleanChat('đéo ai bằng mẹ mày'), '*** ai bằng ***');
  assert.equal([...cleanChat('a'.repeat(200))].length, 60);
});

t('đội: leo, tụt, chặn ở đỉnh và đáy, xếp hạng theo trung bình', () => {
  const m = new TeamMatch({ count: 2, steps: 3 });
  for (const [u, team] of [['a', 0], ['b', 0], ['c', 0], ['x', 1]]) m.join(u, u, '', team);
  m.apply([{ uid: 'x', correct: false }], true); assert.equal(m.players.get('x').step, 0, 'không tụt dưới bậc 0');
  for (let i = 0; i < 5; i++) m.apply([{ uid: 'x', correct: true }], true);
  assert.equal(m.players.get('x').step, 3, 'không vượt quá đỉnh');
  m.apply([{ uid: 'a', correct: true }, { uid: 'b', correct: true }, { uid: 'c', correct: false }], true);
  const st = m.standings();
  assert.equal(st[0].id, 1, 'đội 1 người ở đỉnh thắng đội 3 người ở thấp'); assert.equal(st[1].avg, 0.7);
  assert.equal(st[1].members, 3); assert.equal(st[1].active, 3);
  assert.equal(m.mvp().uid, 'x');
  m.apply([{ uid: 'a', correct: false }], false); assert.equal(m.players.get('a').step, 1, 'tắt luật tụt bậc thì giữ nguyên');
});

t('đội: trận sau giữ đội, về bậc 0, được đổi đội lại', () => {
  const m = new TeamMatch({ count: 2, steps: 5 }); m.join('a', 'A', '', 1); m.join('a', 'A', '', 0); m.apply([{ uid: 'a', correct: true }], true);
  const n = m.next(); const p = n.players.get('a');
  assert.equal(n.no, 2); assert.equal(p.team, 0); assert.equal(p.step, 0); assert.equal(p.switches, 0); assert.equal(p.active, false);
});

console.log(`\n${n} nhóm kiểm tra đều đạt`);
