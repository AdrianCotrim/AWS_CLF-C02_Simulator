'use strict';

const KEY = 'clf-c02-progress';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let Q = [];          // questões válidas (somente leitura)
let byId = {};
let P = loadProgress();   // progresso (LocalStorage)
let S = null;        // sessão atual: { mode, ids, idx, answers, persist, done }
let sel = [];        // seleção atual na tela

/* ---------- Progresso ---------- */
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    if (p && typeof p.questionProgress === 'object') return { history: [], session: null, ...p };
  } catch (e) { /* progresso corrompido: começa vazio */ }
  return { version: 1, questionProgress: {}, history: [], session: null };
}

function stats() {
  const v = Object.entries(P.questionProgress).filter(([id]) => byId[id]);
  const answered = v.length, correct = v.filter(([, p]) => p.lastCorrect).length;
  return {
    answered, correct, wrong: answered - correct,
    percent: answered ? Math.round(correct / answered * 1000) / 10 : 0,
    new: Q.length - answered, total: Q.length,
    errorBank: v.filter(([, p]) => p.inErrorBank).length
  };
}

function save() {
  P.version = 1;
  P.statistics = stats();
  P.errorBank = Object.keys(P.questionProgress).filter(id => P.questionProgress[id].inErrorBank);
  P.session = S && S.persist && !S.done ? S : null;
  try { localStorage.setItem(KEY, JSON.stringify(P)); }
  catch (e) { toast('Não foi possível salvar o progresso neste navegador.'); }
}

function record(q, ok) {
  const p = P.questionProgress[q.id] || (P.questionProgress[q.id] = { timesAnswered: 0, timesWrong: 0, inErrorBank: false });
  p.timesAnswered++;
  p.lastAnswered = new Date().toISOString().slice(0, 10);
  p.lastCorrect = ok;
  if (!ok) { p.timesWrong++; p.inErrorBank = true; }
  else if (S.mode === 'errors') p.inErrorBank = false; // acertou na revisão: sai do banco
  P.history.push({ id: q.id, ok, mode: S.mode, date: new Date().toISOString() });
}

/* ---------- Carregamento e validação ---------- */
function validate(q, seen) {
  if (!q || typeof q !== 'object') return 'item inválido';
  if (!q.id || typeof q.id !== 'string') return 'sem id';
  if (seen.has(q.id)) return 'ID duplicado';
  if (!q.question || typeof q.question !== 'string') return 'questão sem texto';
  if (!['single_choice', 'multiple_choice'].includes(q.type)) return 'tipo inválido';
  const keys = q.options && typeof q.options === 'object' ? Object.keys(q.options) : [];
  if (keys.length < 2) return 'alternativas ausentes';
  const c = q.correct_answer;
  if (!Array.isArray(c) || !c.length) return 'resposta correta inexistente';
  if (c.some(x => !keys.includes(x))) return 'correct_answer incompatível com as alternativas';
  if (q.type === 'single_choice' && c.length !== 1) return 'single_choice com mais de uma resposta';
  return null;
}

async function init() {
  let data;
  try {
    const r = await fetch('data/questions.json');
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    if (!Array.isArray(data)) throw new Error('não é uma lista');
  } catch (e) {
    $('main').innerHTML = `<div class="banner err"><p><b>Não foi possível carregar o banco de questões.</b></p>
      <p>Verifique se o arquivo <code>data/questions.json</code> existe e está formatado corretamente.</p>
      <p>Se você abriu o <code>index.html</code> com duplo clique, use um servidor local (veja o README).</p></div>`;
    return;
  }
  const seen = new Set(), problems = [];
  data.forEach((q, i) => {
    const err = validate(q, seen);
    if (err) problems.push(`#${i + 1} (${q && q.id ? q.id : 'sem id'}): ${err}`);
    else { seen.add(q.id); Q.push(q); byId[q.id] = q; }
  });
  if (problems.length) {
    $('warn').hidden = false;
    $('warn').innerHTML = `<b>${problems.length} questão(ões) ignorada(s) por problemas no banco:</b><br>${problems.map(esc).join('<br>')}`;
  }
  if (!Q.length) { $('main').innerHTML = '<div class="banner err">Nenhuma questão válida encontrada.</div>'; return; }
  // retoma simulado interrompido
  const s = P.session;
  if (s && s.persist && !s.done && Array.isArray(s.ids) && s.ids.every(id => byId[id])) S = s;
  render();
}

/* ---------- Sessões ---------- */
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function start(mode) {
  if (S && S.persist && !S.done && !confirm('Há um simulado em andamento. Descartá-lo e iniciar outra sessão?')) return;
  const pq = P.questionProgress;
  let pool = Q;
  if (mode === 'new') pool = Q.filter(q => !pq[q.id]);
  if (mode === 'errors') pool = Q.filter(q => pq[q.id] && pq[q.id].inErrorBank);
  if (!pool.length) { toast(mode === 'new' ? 'Você já respondeu todas as questões.' : mode === 'errors' ? 'Seu Banco de Erros está vazio.' : 'Sem questões.'); return; }
  let ids = shuffle(pool.map(q => q.id));
  if (mode === 'exam') ids = ids.slice(0, Math.max(1, Math.min(parseInt($('examCount').value, 10) || 60, ids.length)));
  S = { mode, ids, idx: 0, answers: {}, persist: mode === 'exam', done: false };
  save(); render();
}

const MODES = { all: 'Todas', new: 'Questões novas', errors: 'Banco de Erros', exam: 'Simulado' };
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/* ---------- Renderização ---------- */
function renderStats() {
  if (!Q.length) return;
  const s = stats();
  $('stats').innerHTML = `<span>Respondidas: <b>${s.answered}</b></span><span>Acertos: <b>${s.correct}</b></span>
    <span>Erros: <b>${s.wrong}</b></span><span>Aproveitamento: <b>${String(s.percent).replace('.', ',')}%</b></span>
    <span>Novas: <b>${s.new}</b> / ${s.total}</span><span>Banco de Erros: <b>${s.errorBank}</b></span>`;
}

function render() {
  renderStats();
  const m = $('main');
  if (!S) { m.innerHTML = '<p class="muted">Escolha um modo acima para começar.</p>'; return; }
  if (S.done) return renderResult(m);

  const q = byId[S.ids[S.idx]], a = S.answers[q.id], multi = q.type === 'multiple_choice';
  sel = a ? a.sel : [];
  const last = S.idx === S.ids.length - 1;
  const opts = Object.entries(q.options).map(([k, t]) => {
    let cls = 'opt';
    if (a) cls += ' locked' + (q.correct_answer.includes(k) ? ' ok' : sel.includes(k) ? ' bad' : '');
    else if (sel.includes(k)) cls += ' picked';
    return `<label class="${cls}"><input type="${multi ? 'checkbox' : 'radio'}" name="opt" value="${esc(k)}"
      ${sel.includes(k) ? 'checked' : ''} ${a ? 'disabled' : ''}><span><b>${esc(k)})</b> ${esc(t)}</span></label>`;
  }).join('');

  let feedback = '';
  if (a) {
    feedback = `<div class="result ${a.ok ? 'ok' : 'bad'}"><b>${a.ok ? '✓ Resposta correta!' : '✗ Resposta incorreta.'}</b>
      ${a.ok ? '' : `<br>Sua resposta: ${esc(sel.slice().sort().join(', '))}`}
      <br>Resposta correta: ${esc(q.correct_answer.slice().sort().join(', '))}</div>
      ${q.explanation ? `<div class="expl"><b>Explicação:</b><br>${esc(q.explanation)}</div>` : ''}`;
  }
  const inBank = P.questionProgress[q.id] && P.questionProgress[q.id].inErrorBank;
  m.innerHTML = `<div class="card">
    <div class="meta"><span>Modo: ${MODES[S.mode]}</span><span>Questão ${S.idx + 1} / ${S.ids.length}</span></div>
    <div class="progress"><div style="width:${(S.idx + (a ? 1 : 0)) / S.ids.length * 100}%"></div></div>
    <p class="qtext">${esc(q.question)}</p>
    ${multi ? `<p class="hint">Múltiplas respostas: selecione ${q.correct_answer.length}.</p>` : ''}
    <div id="opts">${opts}</div>${feedback}
    <div class="actions">
      ${S.mode === 'exam' && S.idx > 0 ? '<button data-act="prev">Anterior</button>' : ''}
      ${a ? '' : '<button class="primary" data-act="submit">Responder</button>'}
      ${a ? `<button class="primary" data-act="next">${last ? 'Ver resultado' : 'Próxima'}</button>` : ''}
      ${a && a.ok ? `<button data-act="guess" ${inBank ? 'disabled' : ''}>Acertei por chute</button>` : ''}
      <button data-act="quit">Encerrar sessão</button>
    </div></div>`;
}

function renderResult(m) {
  const n = S.ids.length, right = S.ids.filter(id => S.answers[id] && S.answers[id].ok).length;
  const wrong = S.ids.filter(id => !(S.answers[id] && S.answers[id].ok));
  m.innerHTML = `<div class="card"><h2>Resultado — ${MODES[S.mode]}</h2>
    <p><b>${right} / ${n}</b> acertos (${String(Math.round(right / n * 1000) / 10).replace('.', ',')}%)</p>
    ${wrong.length ? `<p>Questões erradas:</p><ol class="wrong-list">${wrong.map(id => `<li>${esc(byId[id].question.slice(0, 140))}</li>`).join('')}</ol>`
      : '<p>Nenhum erro. Ótimo!</p>'}
    <div class="actions"><button class="primary" data-act="quit">Voltar ao início</button></div></div>`;
}

/* ---------- Eventos ---------- */
$('main').addEventListener('change', e => {
  if (e.target.name !== 'opt') return;
  const q = byId[S.ids[S.idx]];
  if (q.type === 'single_choice') sel = [e.target.value];
  else sel = [...document.querySelectorAll('#opts input:checked')].map(i => i.value);
  document.querySelectorAll('#opts .opt').forEach(l => l.classList.toggle('picked', sel.includes(l.querySelector('input').value)));
});

$('main').addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (!act || !S) return;
  const q = S.done ? null : byId[S.ids[S.idx]];
  if (act === 'submit') {
    if (!sel.length) return toast('Selecione uma alternativa.');
    const ok = sameSet(sel, q.correct_answer);
    S.answers[q.id] = { sel: sel.slice(), ok };
    record(q, ok); save(); render();
  } else if (act === 'next') {
    if (S.idx < S.ids.length - 1) S.idx++; else S.done = true;
    save(); render();
  } else if (act === 'prev') {
    S.idx--; save(); render();
  } else if (act === 'guess') {
    P.questionProgress[q.id].inErrorBank = true; save(); render();
    toast('Questão adicionada ao Banco de Erros.');
  } else if (act === 'quit') {
    if (!S.done && !confirm('Encerrar a sessão atual? As respostas já enviadas continuam salvas.')) return;
    S = null; save(); render();
  }
});

document.querySelector('nav').addEventListener('click', e => { if (e.target.dataset.mode && Q.length) start(e.target.dataset.mode); });

/* ---------- Backup, restauração e reset ---------- */
$('exportBtn').onclick = () => {
  const out = {
    version: 1, exportedAt: new Date().toISOString(), statistics: stats(),
    questionProgress: P.questionProgress,
    errorBank: Object.keys(P.questionProgress).filter(id => P.questionProgress[id].inErrorBank),
    history: P.history
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `clf-c02-progresso-${out.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.version !== 1 || !d.questionProgress || typeof d.questionProgress !== 'object' || Array.isArray(d.questionProgress)) throw new Error('formato');
    if (!confirm('Importar substituirá o progresso atual. Continuar?')) return;
    P = { version: 1, questionProgress: d.questionProgress, history: Array.isArray(d.history) ? d.history : [], session: null };
    S = null; save(); render(); toast('Progresso restaurado.');
  } catch (err) { toast('Arquivo de progresso inválido.'); }
};

$('resetBtn').onclick = () => {
  if (!confirm('Tem certeza que deseja apagar todo o seu progresso?\n\nEsta ação removerá:\n- histórico\n- estatísticas\n- Banco de Erros\n- questões respondidas')) return;
  P = { version: 1, questionProgress: {}, history: [], session: null };
  S = null; localStorage.removeItem(KEY); save(); render(); toast('Progresso apagado.');
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

init();
