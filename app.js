'use strict';

const KEY = 'clf-c02-progress';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let Q = [];          // questões válidas (somente leitura)
let byId = {};
let P = loadProgress();   // progresso (LocalStorage)
let S = null;        // sessão atual: { mode, ids, idx, answers, persist, done }
let sel = [];        // seleção atual na tela
const QUESTION_SOURCES = ['Personal', 'Cloudverse', 'Examtopics'];
const QUESTION_TAGS = ['Conceitos de nuvem', 'Segurança e conformidade', 'Tecnologia', 'Faturamento e definição de preço'];
let currentView = 'simulator';
let questionDraft = createQuestionDraft();
let questionFeedback = null;
let isSubmittingQuestion = false;

function createQuestionDraft() {
  return {
    source: 'Personal',
    tag: QUESTION_TAGS[0],
    question: '',
    options: ['', ''],
    correctAnswer: '',
    explanation: ''
  };
}

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
function normalizeText(s) {
  return String(s ?? '')
    .trim()
    .replace(/[.?!;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return raw;

  const q = { ...raw };
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  if (Array.isArray(q.options)) {
    q.options = q.options.reduce((acc, opt, index) => {
      const key = letters[index] || String(index + 1);
      acc[key] = String(opt);
      return acc;
    }, {});
  } else if (!q.options || typeof q.options !== 'object' || Array.isArray(q.options)) {
    q.options = {};
  }

  const keys = Object.keys(q.options);

  function canonicalize(text) {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\b(?:de|da|do|dos|das|e|em|com|para|por|um|uma|a|o|as|os|que|qual|como|quando|onde|se|nao|não)\b/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function similarity(a, b) {
    const left = canonicalize(a);
    const right = canonicalize(b);
    if (!left.length || !right.length) return 0;
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    const overlap = [...leftSet].filter(word => rightSet.has(word)).length;
    const union = new Set([...leftSet, ...rightSet]).size;
    const jaccard = union ? overlap / union : 0;
    return normalizeText(a).includes(normalizeText(b)) || normalizeText(b).includes(normalizeText(a)) ? 1 : jaccard;
  }

  function matchChoice(value) {
    const target = normalizeText(value);
    if (!target) return null;

    let bestKey = null;
    let bestScore = 0;

    for (const key of keys) {
      const optionText = normalizeText(q.options[key]);
      const score = similarity(target, optionText);
      if (score > bestScore) {
        bestKey = key;
        bestScore = score;
      }
    }

    return bestScore >= 0.35 ? bestKey : null;
  }

  if (typeof q.correct_answer === 'string') {
    const rawValue = q.correct_answer.trim();
    const segments = rawValue.includes(' e ') ? rawValue.split(/\s+e\s+/i) : [rawValue];
    const resolved = segments
      .map(segment => {
        const key = matchChoice(segment);
        if (key) return key;
        const direct = normalizeText(segment).toUpperCase();
        return /^[A-Z]$/.test(direct) ? direct : null;
      })
      .filter(Boolean);
    q.correct_answer = resolved.length ? resolved : (matchChoice(rawValue) ? [matchChoice(rawValue)] : []);
  } else if (Array.isArray(q.correct_answer)) {
    q.correct_answer = q.correct_answer.map(item => {
      if (typeof item === 'string' && /^[A-Z]$/.test(item.trim().toUpperCase())) return item.trim().toUpperCase();
      return matchChoice(item) || normalizeText(item) || null;
    }).filter(Boolean);
  } else {
    q.correct_answer = [];
  }

  if (q.type !== 'single_choice' && q.type !== 'multiple_choice') {
    q.type = q.correct_answer.length > 1 ? 'multiple_choice' : 'single_choice';
  }

  return q;
}

function validate(raw, seen) {
  const q = normalizeQuestion(raw);
  if (!q || typeof q !== 'object') return 'item inválido';
  if (!q.id || typeof q.id !== 'string') return 'sem id';
  if (seen.has(q.id)) return 'ID duplicado';
  if (!q.question || typeof q.question !== 'string') return 'questão sem texto';
  if (!['single_choice', 'multiple_choice'].includes(q.type)) return 'tipo inválido';
  const keys = q.options && typeof q.options === 'object' ? Object.keys(q.options) : [];
  if (keys.length < 2) return 'alternativas ausentes';
  const c = Array.isArray(q.correct_answer) ? q.correct_answer : [];
  if (!c.length) return 'resposta correta inexistente';
  if (c.some(x => !keys.includes(String(x)))) return 'correct_answer incompatível com as alternativas';
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
    const normalized = normalizeQuestion(q);
    const err = validate(normalized, seen);
    if (err) problems.push(`#${i + 1} (${normalized && normalized.id ? normalized.id : 'sem id'}): ${err}`);
    else {
      seen.add(normalized.id);
      Q.push(normalized);
      byId[normalized.id] = normalized;
    }
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
  if (currentView === 'add') return renderQuestionForm(m);
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

function renderQuestionForm(main, focus) {
  const options = questionDraft.options.map((option, index) => `<div class="option-editor">
    <div class="option-editor-heading">
      <label for="question-option-${index}">Resposta ${index + 1}</label>
      <button type="button" class="remove-option" data-form-action="remove-option" data-index="${index}"
        aria-label="Remover resposta ${index + 1}" title="Remover resposta" ${questionDraft.options.length <= 2 ? 'disabled' : ''}>X</button>
    </div>
    <input class="form-control" id="question-option-${index}" data-question-field="option" data-index="${index}"
      type="text" maxlength="500" value="${esc(option)}" placeholder="Digite uma alternativa" required>
  </div>`).join('');
  const correctAnswers = questionDraft.options.map((option, index) => {
    const label = option.trim() || `Resposta ${index + 1} (preencha o texto)`;
    return `<option value="${index}" ${questionDraft.correctAnswer === String(index) ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const feedback = questionFeedback ? `<div id="questionFeedback" class="form-feedback ${questionFeedback.type}"
    role="${questionFeedback.type === 'error' ? 'alert' : 'status'}" aria-live="polite">
    <span>${esc(questionFeedback.message)}</span>${questionFeedback.id ? `<strong>ID: ${esc(questionFeedback.id)}</strong>` : ''}
  </div>` : '';

  main.innerHTML = `<section class="card question-form-card" aria-labelledby="question-form-title">
    <div class="form-heading">
      <div><h2 id="question-form-title">Adicionar questão</h2><p class="muted">O ID será gerado automaticamente.</p></div>
      <button type="button" data-form-action="return">Voltar ao simulador</button>
    </div>
    ${feedback}
    <form id="questionForm" class="question-form" novalidate>
      <div class="form-row">
        <label class="form-field"><span>Source</span>
          <select class="form-control" data-question-field="source" required>${QUESTION_SOURCES.map(source => `<option value="${esc(source)}" ${questionDraft.source === source ? 'selected' : ''}>${esc(source)}</option>`).join('')}</select>
        </label>
        <label class="form-field"><span>Tag</span>
          <select class="form-control" data-question-field="tag" required>${QUESTION_TAGS.map(tag => `<option value="${esc(tag)}" ${questionDraft.tag === tag ? 'selected' : ''}>${esc(tag)}</option>`).join('')}</select>
        </label>
      </div>
      <label class="form-field"><span>Question</span>
        <textarea class="form-control question-textarea" data-question-field="question" maxlength="10000" placeholder="Digite o enunciado da questão..." required>${esc(questionDraft.question)}</textarea>
      </label>
      <fieldset class="options-fieldset">
        <legend>Options</legend>
        <div class="option-editors">${options}</div>
        <button type="button" data-form-action="add-option" ${questionDraft.options.length >= 26 ? 'disabled title="Limite de 26 alternativas da API"' : ''}>+ Adicionar resposta</button>
      </fieldset>
      <label class="form-field"><span>Correct Answer</span>
        <select class="form-control" data-question-field="correctAnswer" required>
          <option value="">Selecione a resposta correta</option>${correctAnswers}
        </select>
      </label>
      <label class="form-field"><span>Explanation <span class="optional-label">(opcional)</span></span>
        <textarea class="form-control explanation-textarea" data-question-field="explanation" maxlength="10000" placeholder="Explique por que essa é a resposta correta.">${esc(questionDraft.explanation)}</textarea>
      </label>
      <div class="form-submit-row"><button class="primary" type="submit" ${isSubmittingQuestion ? 'disabled' : ''}>${isSubmittingQuestion ? 'Enviando...' : 'Adicionar questão'}</button></div>
    </form>
  </section>`;

  if (focus) {
    const field = focus.field === 'option'
      ? main.querySelector(`[data-question-field="option"][data-index="${focus.index}"]`)
      : main.querySelector(`[data-question-field="${focus.field}"]`);
    if (field) field.focus();
  }
}

function refreshCorrectAnswerOptions() {
  const select = $('main').querySelector('[data-question-field="correctAnswer"]');
  if (!select) return;
  const selected = questionDraft.correctAnswer;
  select.innerHTML = `<option value="">Selecione a resposta correta</option>${questionDraft.options.map((option, index) => {
    const label = option.trim() || `Resposta ${index + 1} (preencha o texto)`;
    return `<option value="${index}" ${selected === String(index) ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('')}`;
}

function clearQuestionFeedback() {
  questionFeedback = null;
  const feedback = $('questionFeedback');
  if (feedback) feedback.remove();
}

function validateQuestionDraft() {
  if (!QUESTION_SOURCES.includes(questionDraft.source)) return 'Selecione uma origem válida.';
  if (!QUESTION_TAGS.includes(questionDraft.tag)) return 'Selecione uma categoria válida.';
  if (!questionDraft.question.trim()) return 'Preencha o enunciado da questão.';
  if (questionDraft.options.length < 2) return 'Adicione pelo menos duas alternativas.';
  if (questionDraft.options.some(option => !option.trim())) return 'Preencha todas as alternativas.';
  const normalizedOptions = questionDraft.options.map(option => option.trim().toLocaleLowerCase('pt-BR'));
  if (new Set(normalizedOptions).size !== normalizedOptions.length) return 'As alternativas não podem ser duplicadas.';
  if (!questionDraft.correctAnswer || !questionDraft.options[Number(questionDraft.correctAnswer)]) return 'Selecione uma resposta correta.';
  return '';
}

async function submitQuestion(event) {
  event.preventDefault();
  if (isSubmittingQuestion) return;

  const validationMessage = validateQuestionDraft();
  if (validationMessage) {
    questionFeedback = { type: 'error', message: validationMessage };
    return renderQuestionForm($('main'));
  }

  const correctIndex = Number(questionDraft.correctAnswer);
  const payload = {
    source: questionDraft.source,
    tag: questionDraft.tag,
    question: questionDraft.question.trim(),
    options: questionDraft.options.map(option => option.trim()),
    correct_answer: String.fromCharCode(65 + correctIndex),
    explanation: questionDraft.explanation.trim()
  };

  isSubmittingQuestion = true;
  questionFeedback = { type: 'pending', message: 'Enviando questão...' };
  renderQuestionForm($('main'));

  try {
    const created = await window.QuestionsApi.createQuestion(payload);
    const normalized = normalizeQuestion(created);
    Q.push(normalized);
    byId[normalized.id] = normalized;
    questionDraft = createQuestionDraft();
    questionFeedback = { type: 'success', message: 'Questão adicionada com sucesso!', id: created.id };
    isSubmittingQuestion = false;
    renderStats();
    renderQuestionForm($('main'), { field: 'question' });
  } catch (error) {
    questionFeedback = { type: 'error', message: error.message || 'Não foi possível adicionar a questão. Verifique os dados e tente novamente.' };
    isSubmittingQuestion = false;
    renderQuestionForm($('main'));
  }
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

/* ---------- Cadastro de questões ---------- */
$('main').addEventListener('input', e => {
  const field = e.target.dataset.questionField;
  if (!field || currentView !== 'add') return;
  if (field === 'option') {
    questionDraft.options[Number(e.target.dataset.index)] = e.target.value;
    refreshCorrectAnswerOptions();
  } else {
    questionDraft[field] = e.target.value;
  }
  clearQuestionFeedback();
});

$('main').addEventListener('change', e => {
  const field = e.target.dataset.questionField;
  if (!field || currentView !== 'add') return;
  questionDraft[field] = e.target.value;
  clearQuestionFeedback();
});

$('main').addEventListener('submit', e => {
  if (e.target.id === 'questionForm') submitQuestion(e);
});

/* ---------- Eventos ---------- */
$('main').addEventListener('change', e => {
  if (e.target.name !== 'opt') return;
  const q = byId[S.ids[S.idx]];
  if (q.type === 'single_choice') sel = [e.target.value];
  else sel = [...document.querySelectorAll('#opts input:checked')].map(i => i.value);
  document.querySelectorAll('#opts .opt').forEach(l => l.classList.toggle('picked', sel.includes(l.querySelector('input').value)));
});

$('main').addEventListener('click', e => {
  const formAction = e.target.closest('[data-form-action]');
  if (formAction) {
    const action = formAction.dataset.formAction;
    if (action === 'return') {
      currentView = 'simulator';
      render();
    } else if (action === 'add-option' && questionDraft.options.length < 26) {
      questionDraft.options.push('');
      clearQuestionFeedback();
      renderQuestionForm($('main'), { field: 'option', index: questionDraft.options.length - 1 });
    } else if (action === 'remove-option' && questionDraft.options.length > 2) {
      const removedIndex = Number(formAction.dataset.index);
      questionDraft.options.splice(removedIndex, 1);
      if (questionDraft.correctAnswer === String(removedIndex)) questionDraft.correctAnswer = '';
      else if (Number(questionDraft.correctAnswer) > removedIndex) questionDraft.correctAnswer = String(Number(questionDraft.correctAnswer) - 1);
      clearQuestionFeedback();
      renderQuestionForm($('main'), { field: 'option', index: Math.max(0, removedIndex - 1) });
    }
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'return') {
    currentView = 'simulator';
    render();
    return;
  }
  if (!S) return;
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

document.querySelector('nav').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.view === 'add') {
    currentView = 'add';
    render();
  } else if (button.dataset.mode && Q.length) {
    currentView = 'simulator';
    start(button.dataset.mode);
  }
});

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
