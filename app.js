'use strict';

const KEY = 'clf-c02-progress';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let Q = [];          // questões válidas (somente leitura)
let byId = {};
let P = createEmptyProgress();
let S = null;        // sessão atual: { mode, ids, idx, answers, persist, done, startedAt, elapsedMs }
let sel = [];        // seleção atual na tela
let examTimerInterval = null;
let progressSaveQueue = Promise.resolve();
let pendingProgressSaves = 0;
let progressSaveError = false;
let progressPersisted = false;
let availableTags = [];
let currentView = 'simulator';
let viewBeforeSettings = 'simulator';
let examConfiguration = { count: 60, timed: false, minutes: 90, selection: 'all', source: '', tag: '' };
let questionMapVisible = false;
let questionDraft = createQuestionDraft();
let questionFeedback = null;
let isSubmittingQuestion = false;
let duplicateMatches = null;
let editingQuestionId = null;
let bankQuestions = [];
let bankStatus = 'idle';
let bankError = '';
let bankSelectedId = null;
let bankListScrollY = 0;
let bankRequestVersion = 0;
let bankFilters = { query: '', tag: '', errorBank: '' };
let bankDeleteError = '';
let isDeletingQuestion = false;
let isRestoringQuestion = false;
let selectedQuestionMetadata = null;
let catalogStatus = null;
let statisticsPeriod = '7';
let statisticsSort = { topics: 'lowest' };

function createQuestionDraft() {
  return {
    tag: '',
    question: '',
    options: ['', ''],
    multipleAnswers: false,
    correctAnswers: [''],
    addToErrorBank: false,
    explanation: ''
  };
}

function renderCatalogNotice(status) {
  const notice = $('catalogNotice');
  if (!notice) return;
  catalogStatus = status;
  if (!status || !status.initialized) {
    notice.hidden = true;
    notice.innerHTML = '';
    return;
  }

  const changes = status.added.length + status.changed.length + status.removed.length;
  const conflicts = status.conflicts || [];
  if (!changes && !conflicts.length) {
    notice.hidden = true;
    notice.innerHTML = '';
    return;
  }

  const details = [];
  if (status.added.length) details.push(`${status.added.length} novas`);
  if (status.changed.length) details.push(`${status.changed.length} atualizadas`);
  if (status.removed.length) details.push(`${status.removed.length} removidas`);
  const conflictIds = conflicts.slice(0, 8).map(item => esc(item.id)).join(', ');
  notice.innerHTML = `<b>O catálogo padrão mudou.</b> ${details.join(', ') || 'Há alterações locais em conflito'}.
    As questões locais, edições e exclusões foram preservadas.
    ${conflicts.length ? `<p>${conflicts.length} conflito(s) em alterações locais: ${conflictIds}${conflicts.length > 8 ? ', …' : ''}. Restaure a versão padrão ou mantenha a edição local.</p>` : ''}
    ${changes ? '<button type="button" class="link" data-catalog-action="acknowledge">Registrar que revisei este relatório</button>' : ''}`;
  notice.hidden = false;
}

/* ---------- Progresso ---------- */
function createEmptyProgress() {
  return { version: 1, questionProgress: {}, history: [], session: null };
}

function validateProgressState(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)
    || progress.version !== 1
    || !progress.questionProgress || typeof progress.questionProgress !== 'object' || Array.isArray(progress.questionProgress)
    || !Array.isArray(progress.history)
    || (progress.session !== null && (!progress.session || typeof progress.session !== 'object' || Array.isArray(progress.session)
      || progress.session.persist !== true || progress.session.done === true
      || !Array.isArray(progress.session.ids) || !progress.session.ids.length
      || !Number.isInteger(progress.session.idx) || progress.session.idx < 0 || progress.session.idx >= progress.session.ids.length
      || !progress.session.answers || typeof progress.session.answers !== 'object' || Array.isArray(progress.session.answers)))) {
    throw new Error('O progresso legado não possui uma estrutura compatível. Ele foi mantido no LocalStorage sem alterações.');
  }
  return progress;
}

function readLegacyProgress() {
  try {
    const contents = localStorage.getItem(KEY);
    if (contents === null) return null;
    try {
      return validateProgressState(JSON.parse(contents));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('O progresso encontrado no LocalStorage contém JSON inválido. Ele foi mantido sem alterações.');
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('LocalStorage')) throw error;
    throw new Error('Não foi possível ler o progresso legado deste navegador.');
  }
}

function stats() {
  const v = Object.entries(P.questionProgress).filter(([id, progress]) => byId[id] && progress.timesAnswered > 0);
  const answered = v.length, correct = v.filter(([, p]) => p.lastCorrect).length;
  return {
    answered, correct, wrong: answered - correct,
    percent: answered ? Math.round(correct / answered * 1000) / 10 : 0,
    new: Q.length - answered, total: Q.length,
    errorBank: Q.filter(question => P.questionProgress[question.id] && P.questionProgress[question.id].inErrorBank).length
  };
}

function renderProgressSaveStatus() {
  const status = $('saveStatus');
  if (!status) return;
  status.textContent = pendingProgressSaves
    ? 'Salvando progresso...'
    : progressSaveError ? 'Falha ao salvar progresso; confira a notificação.'
      : progressPersisted ? 'Progresso salvo no dispositivo' : 'Progresso ainda não salvo';
  status.classList.toggle('saving', pendingProgressSaves > 0);
  status.classList.toggle('save-error', progressSaveError && pendingProgressSaves === 0);
}

function save() {
  P.version = 1;
  P.statistics = stats();
  P.errorBank = Object.keys(P.questionProgress).filter(id => P.questionProgress[id].inErrorBank);
  P.session = S && S.persist && !S.done ? S : null;
  const snapshot = structuredClone(P);
  pendingProgressSaves++;
  renderProgressSaveStatus();
  const operation = progressSaveQueue.catch(() => {}).then(() => window.QuestionsApi.saveProgress(snapshot));
  progressSaveQueue = operation;
  return operation.then(() => {
    progressSaveError = false;
    progressPersisted = true;
    return true;
  }).catch(error => {
    progressSaveError = true;
    toast(error.message || 'Não foi possível salvar o progresso no dispositivo.');
    return false;
  }).finally(() => {
    pendingProgressSaves--;
    renderProgressSaveStatus();
  });
}

async function setErrorBankMembership(id, shouldAdd, notify = true) {
  if (!byId[id]) return false;

  const previous = P.questionProgress[id];
  const wasInBank = Boolean(previous && previous.inErrorBank);
  if (wasInBank === shouldAdd) return true;

  const progress = previous
    ? { ...previous }
    : { timesAnswered: 0, timesWrong: 0, inErrorBank: false };
  progress.inErrorBank = shouldAdd;
  P.questionProgress[id] = progress;
  if (await save()) {
    if (notify) toast(shouldAdd ? 'Questão adicionada ao Banco de Erros.' : 'Questão removida do Banco de Erros.');
    return true;
  }

  if (previous) P.questionProgress[id] = previous;
  else delete P.questionProgress[id];
  P.errorBank = Object.keys(P.questionProgress).filter(questionId => P.questionProgress[questionId].inErrorBank);
  renderStats();
  if (notify) toast('Não foi possível atualizar o Banco de Erros no dispositivo.');
  return false;
}

async function initializeProgress() {
  const current = await window.QuestionsApi.getProgress();
  if (current.exists) {
    P = current.progress;
    progressPersisted = true;
  }
  renderProgressSaveStatus();

  if (current.migration) {
    return;
  }

  let legacy;
  try {
    legacy = readLegacyProgress();
  } catch (error) {
    toast(error.message);
    if (!current.exists) {
      P = createEmptyProgress();
      await save();
    }
    return;
  }

  if (legacy) {
    let preview;
    try {
      preview = await window.QuestionsApi.previewProgressMigration(legacy);
    } catch (error) {
      toast(error.message);
      return;
    }
    const summary = preview.summary;
    const backendSummary = preview.backend.summary;
    const existingData = preview.backend.hasData;
    const message = existingData
      ? `Foram encontrados dados no LocalStorage e progresso já persistido no backend.\n\n` +
        `LocalStorage: ${summary.progressEntries} questões, ${summary.responseHistory} respostas, sessão ativa: ${summary.hasActiveSession ? 'sim' : 'não'}.\n` +
        `Backend: ${backendSummary.progressEntries} questões, ${backendSummary.responseHistory} respostas, sessão ativa: ${backendSummary.hasActiveSession ? 'sim' : 'não'}.\n\n` +
        'SIM substitui o progresso do backend pelos dados legados; serão criados backups separados dos dois estados. NÃO mantém o backend atual e preserva o LocalStorage sem alterá-lo.'
      : `Foi encontrado progresso legado neste navegador:\n\n` +
        `- Questões com progresso: ${summary.progressEntries}\n` +
        `- Respostas no histórico: ${summary.responseHistory}\n` +
        `- Banco de erros: ${summary.errorBankEntries}\n` +
        `- Sessão ativa: ${summary.hasActiveSession ? `sim (${summary.sessionQuestionCount} questões)` : 'não'}\n\n` +
        'A migração criará um backup antes de gravar e verificará os dados depois. O LocalStorage não será apagado. Migrar agora?';
    if (confirm(message)) {
      try {
        const result = await window.QuestionsApi.migrateProgress(legacy, existingData);
        P = result.progress;
        progressPersisted = true;
        progressSaveError = false;
        renderProgressSaveStatus();
        S = P.session && P.session.ids.every(id => byId[id]) ? P.session : null;
        toast(`Migração concluída e verificada. Backup legado: ${result.backups.legacyBackup}`);
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (!current.exists) {
      P = createEmptyProgress();
      await save();
    }
    return;
  }

  if (!current.exists) {
    P = createEmptyProgress();
    await save();
  }
}

function record(q, ok) {
  const p = P.questionProgress[q.id] || (P.questionProgress[q.id] = { timesAnswered: 0, timesWrong: 0, inErrorBank: false });
  const wasInErrorBank = Boolean(p.inErrorBank);
  p.timesAnswered++;
  p.lastAnswered = new Date().toISOString().slice(0, 10);
  p.lastCorrect = ok;
  if (!ok) { p.timesWrong++; p.inErrorBank = true; }
  else if (S.mode === 'errors') p.inErrorBank = false; // acertou na revisão: sai do banco
  P.history.push({
    id: q.id,
    ok,
    mode: S.mode,
    date: new Date().toISOString(),
    tag: q.tag || '',
    wasInErrorBank,
    ...(S.mode === 'exam' && S.sessionId ? { sessionId: S.sessionId } : {})
  });
}

/* ---------- Carregamento e validação ---------- */
function normalizeText(s) {
  return String(s ?? '')
    .trim()
    .replace(/[.?!;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeQuestionText(text) {
  const template = document.createElement('template');
  const html = String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:address|article|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)\s*>/gi, ' ');
  template.innerHTML = html;
  return (template.content.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function findDuplicateQuestions(questionText, existingQuestions, ignoredId = null) {
  const normalizedQuestion = normalizeQuestionText(questionText);
  if (!normalizedQuestion) return [];
  return existingQuestions.filter(question =>
    question &&
    question.id !== ignoredId &&
    typeof question.question === 'string' &&
    normalizeQuestionText(question.question) === normalizedQuestion
  );
}

function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return raw;

  const q = { ...raw };
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const hasMultipleAnswers = q.type
    ? q.type === 'multiple_choice'
    : Array.isArray(q.correct_answer);

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
    const exactKey = keys.find(key => normalizeText(q.options[key]).toLocaleLowerCase('pt-BR') === target.toLocaleLowerCase('pt-BR'));
    if (exactKey) return exactKey;

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

  function matchChoices(value) {
    const target = normalizeText(value).toLocaleLowerCase('pt-BR');
    const exactKey = keys.find(key => normalizeText(q.options[key]).toLocaleLowerCase('pt-BR') === target);
    if (exactKey) return [exactKey];

    const matches = [];
    for (const [keyIndex, key] of keys.entries()) {
      const optionText = normalizeText(q.options[key]).toLocaleLowerCase('pt-BR');
      if (!optionText) continue;
      let start = target.indexOf(optionText);
      while (start !== -1) {
        matches.push({ key, keyIndex, start, end: start + optionText.length, length: optionText.length });
        start = target.indexOf(optionText, start + 1);
      }
    }

    if (matches.length) {
      const selected = [];
      for (const match of matches.sort((left, right) => right.length - left.length || left.start - right.start)) {
        if (!selected.some(item => item.key === match.key || (match.start < item.end && match.end > item.start))) {
          selected.push(match);
        }
      }
      const spans = selected.slice().sort((left, right) => left.start - right.start);
      const remaining = spans.reduce((parts, match, index) => {
        const previousEnd = index ? spans[index - 1].end : 0;
        parts.push(target.slice(previousEnd, match.start));
        if (index === spans.length - 1) parts.push(target.slice(match.end));
        return parts;
      }, []).join(' ');
      const remainingKey = matchChoice(remaining);
      if (remainingKey && !selected.some(match => match.key === remainingKey)) {
        selected.push({ key: remainingKey, keyIndex: keys.indexOf(remainingKey), start: -1, end: -1, length: 0 });
      }
      return selected.sort((left, right) => left.keyIndex - right.keyIndex).map(match => match.key);
    }

    const key = matchChoice(value);
    return key ? [key] : [];
  }

  if (typeof q.correct_answer === 'string') {
    const rawValue = q.correct_answer.trim();
    const direct = normalizeText(rawValue).toUpperCase();
    q.correct_answer = /^[A-Z]$/.test(direct) ? [direct] : matchChoices(rawValue);
  } else if (Array.isArray(q.correct_answer)) {
    q.correct_answer = q.correct_answer.map(item => {
      if (typeof item === 'string' && /^[A-Z]$/.test(item.trim().toUpperCase())) return item.trim().toUpperCase();
      return matchChoice(item) || normalizeText(item) || null;
    }).filter(Boolean);
  } else {
    q.correct_answer = [];
  }

  q.type = hasMultipleAnswers || q.correct_answer.length > 1 ? 'multiple_choice' : 'single_choice';

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
  if (new Set(c).size !== c.length) return 'respostas corretas duplicadas';
  if (q.type === 'single_choice' && c.length !== 1) return 'single_choice com mais de uma resposta';
  return null;
}

async function init() {
  let data;
  try {
    data = await window.QuestionsApi.getQuestions();
    if (!Array.isArray(data)) throw new Error('não é uma lista');
  } catch (e) {
    $('main').innerHTML = `<div class="banner err"><p><b>Não foi possível carregar o banco de questões.</b></p>
      <p>${esc(e.message || 'Verifique se o backend está funcionando.')}</p>
      <p>O progresso e o catálogo efetivo são carregados pela API local; consulte o README para iniciar o aplicativo.</p></div>`;
    return;
  }
  try {
    renderCatalogNotice(await window.QuestionsApi.getCatalogStatus());
  } catch (error) {
    toast(error.message || 'Não foi possível verificar as atualizações do catálogo.');
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
  try {
    const userData = await window.QuestionsApi.getUserData();
    availableTags = normalizeTags(userData.preferences.tags);
  } catch (error) {
    toast(error.message || 'Não foi possível carregar as tags cadastradas.');
  }
  if (!Q.length) { $('main').innerHTML = '<div class="banner err">Nenhuma questão válida encontrada.</div>'; return; }
  try {
    await initializeProgress();
  } catch (error) {
    $('main').innerHTML = `<div class="banner err"><b>Não foi possível carregar o progresso persistido.</b><p>${esc(error.message)}</p></div>`;
    return;
  }
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

function createExamSessionId() {
  return `exam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = value => String(value).padStart(2, '0');
  return hours
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(Math.floor(totalSeconds / 60))}:${pad(seconds)}`;
}

function getExamElapsedMs(session, now = Date.now()) {
  if (Number.isFinite(session.elapsedMs)) return session.elapsedMs;
  return Math.max(0, now - session.startedAt);
}

function getExamRemainingMs(session, now = Date.now()) {
  return Math.max(0, session.deadlineAt - now);
}

function getExamSummary(session = S) {
  if (!session || !Array.isArray(session.ids)) return { total: 0, answered: 0, unanswered: 0, reviewed: 0, correct: 0, errors: 0, percent: 0 };

  const total = session.ids.length;
  let answered = 0;
  let reviewed = 0;
  let correct = 0;
  let errors = 0;

  for (const id of session.ids) {
    const answer = session.answers[id];
    if (answer && Array.isArray(answer.sel) && answer.sel.length) {
      answered++;
    }
    if (answer && answer.reviewed) reviewed++;
    if (answer && answer.ok) correct++;
    else if (answer && answer.hasOwnProperty('ok') && !answer.ok) errors++;
  }

  const unanswered = total - answered;
  const percent = answered ? (correct / answered) * 100 : 0;

  return { total, answered, unanswered, reviewed, correct, errors, percent };
}

function formatExamRemaining(milliseconds) {
  const totalSeconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours) {
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = totalSeconds % 60;
    const pad = value => String(value).padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return formatDuration(totalSeconds * 1000);
}

function isExamExpired(session, now = Date.now()) {
  return Number.isFinite(session.deadlineAt) && getExamRemainingMs(session, now) === 0;
}

function getExamTimerClass(session, now = Date.now()) {
  if (!Number.isFinite(session.deadlineAt)) return '';
  const remainingMs = getExamRemainingMs(session, now);
  if (remainingMs <= 60 * 1000) return 'critical';
  if (remainingMs <= 10 * 60 * 1000) return 'attention';
  return '';
}

function clearExamTimer() {
  if (examTimerInterval !== null) {
    clearInterval(examTimerInterval);
    examTimerInterval = null;
  }
}

function finishExam(completionReason) {
  if (!S || S.mode !== 'exam' || S.done) return false;
  S.done = true;
  S.completionReason = completionReason;
  const elapsedMs = getExamElapsedMs(S);
  S.elapsedMs = Number.isFinite(S.durationMs) ? Math.min(elapsedMs, S.durationMs) : elapsedMs;
  const summary = getExamSummary(S);
  if (S.sessionId) {
    P.history.push({
      type: 'exam-completed',
      sessionId: S.sessionId,
      date: new Date().toISOString(),
      elapsedMs: S.elapsedMs,
      completionReason,
      total: summary.total,
      answered: summary.answered,
      unanswered: summary.unanswered,
      reviewed: summary.reviewed,
      correct: summary.correct,
      errors: summary.errors,
      percent: summary.percent
    });
  }
  clearExamTimer();
  save();
  render();
  return true;
}

function syncExamTimer() {
  if (!S || S.mode !== 'exam' || S.done) {
    clearExamTimer();
    return;
  }

  if (!Number.isFinite(S.startedAt)) S.startedAt = Date.now();
  const updateDisplay = () => {
    if (isExamExpired(S)) {
      finishExam('time-expired');
      return;
    }
    const timer = $('examTimer');
    if (!timer) return;
    if (Number.isFinite(S.deadlineAt)) {
      const remainingMs = getExamRemainingMs(S);
      timer.textContent = formatExamRemaining(remainingMs);
      const timerClass = getExamTimerClass(S);
      timer.classList.toggle('attention', timerClass === 'attention');
      timer.classList.toggle('critical', timerClass === 'critical');
      timer.setAttribute('aria-label', `Tempo restante: ${timer.textContent}`);
    } else {
      timer.textContent = formatDuration(getExamElapsedMs(S));
    }
  };
  updateDisplay();
  if (examTimerInterval === null) examTimerInterval = setInterval(updateDisplay, 250);
}

function getExamPool(configuration) {
  const pq = P.questionProgress;
  let pool = Q;
  if (configuration.selection === 'new') pool = Q.filter(q => !pq[q.id]);
  if (configuration.selection === 'errors') pool = Q.filter(q => pq[q.id] && pq[q.id].inErrorBank);
  if (configuration.source) pool = pool.filter(q => q.source === configuration.source);
  if (configuration.tag) pool = pool.filter(q => q.tag === configuration.tag);
  return pool;
}

function start(mode, configuration = null) {
  if (mode === 'exam' && (!configuration
    || !Number.isSafeInteger(configuration.count) || configuration.count <= 0)) {
    toast('Informe uma quantidade inteira e positiva de questões.');
    return;
  }
  let durationMs;
  if (mode === 'exam' && configuration && configuration.timed) {
    const minutes = configuration.minutes;
    const requestedDurationMs = minutes * 60 * 1000;
    if (!Number.isSafeInteger(minutes) || minutes <= 0 || !Number.isSafeInteger(requestedDurationMs)
      || !Number.isSafeInteger(Date.now() + requestedDurationMs)) {
      toast('Informe um limite de tempo válido em minutos.');
      $('main').querySelector('[data-exam-field="minutes"]')?.focus();
      return;
    }
    durationMs = requestedDurationMs;
  }
  if (S && S.persist && !S.done && !confirm('Há um simulado em andamento. Descartá-lo e iniciar outra sessão?')) return;
  const pool = mode === 'exam' ? getExamPool(configuration) : (() => {
    const pq = P.questionProgress;
    if (mode === 'new') return Q.filter(q => !pq[q.id]);
    if (mode === 'errors') return Q.filter(q => pq[q.id] && pq[q.id].inErrorBank);
    return Q;
  })();
  if (!pool.length) { toast(mode === 'new' ? 'Você já respondeu todas as questões.' : mode === 'errors' ? 'Seu Banco de Erros está vazio.' : 'Sem questões.'); return; }
  let ids = shuffle(pool.map(q => q.id));
  if (mode === 'exam') {
    const count = configuration.count;
    ids = ids.slice(0, count);
    const modeLabel = Number.isFinite(durationMs) ? `${formatDuration(durationMs)} de tempo` : 'sem limite de tempo';
    if (!confirm(`Iniciar simulado:
- ${count} questões
- ${modeLabel}
- Ordem aleatória definida no início`)) return;
  }
  clearExamTimer();
  questionMapVisible = false;
  const startedAt = Date.now();
  S = {
    mode, ids, idx: 0, answers: {}, persist: mode === 'exam', done: false,
    ...(mode === 'exam' ? {
      sessionId: createExamSessionId(),
      startedAt,
      ...(Number.isFinite(durationMs) ? { durationMs, deadlineAt: startedAt + durationMs } : {})
    } : {})
  };
  currentView = 'simulator';
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

function normalizeTags(tags) {
  const result = [];
  const names = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    const normalized = trimmed.toLocaleLowerCase('pt-BR');
    if (!trimmed || names.has(normalized)) continue;
    names.add(normalized);
    result.push(trimmed);
  }
  return result;
}

async function persistTags(tags) {
  const result = await window.QuestionsApi.updatePreferences({ tags: normalizeTags(tags) });
  availableTags = normalizeTags(result.preferences.tags);
}

function renderSettings(main) {
  const tagList = availableTags.length
    ? `<ul class="settings-tag-list">${availableTags.map(tag => `<li><span>${esc(tag)}</span>
        <button type="button" class="link danger" data-settings-action="remove-tag" data-tag="${esc(tag)}">Remover</button>
      </li>`).join('')}</ul>`
    : '<p class="muted">Nenhuma tag cadastrada.</p>';
  main.innerHTML = `<section class="card settings-screen" aria-labelledby="settings-title">
    <h2 id="settings-title">Configurações</h2>
    <section aria-labelledby="settings-tags-title">
      <h3 id="settings-tags-title">Tags</h3>
      <form id="tagForm" class="settings-tag-form">
        <label class="form-field"><span>Nova tag</span>
          <input class="form-control" name="tag" type="text" maxlength="100" autocomplete="off">
        </label>
        <button class="primary" type="submit">Adicionar tag</button>
      </form>
      <div id="settingsTagFeedback" class="form-feedback error" role="alert" hidden></div>
      ${tagList}
    </section>
    <button type="button" data-settings-action="back">Voltar</button>
  </section>`;
}

function renderExamConfiguration(main) {
  const sources = normalizeTags(Q.map(question => question.source).filter(Boolean));
  const tags = normalizeTags(Q.map(question => question.tag).filter(Boolean));
  const pool = getExamPool(examConfiguration);
  const sourceOptions = sources.length
    ? `<label class="form-field"><span>Fonte</span><select class="form-control" data-exam-field="source">
        <option value="">Todas as fontes</option>
        ${sources.map(source => `<option value="${esc(source)}" ${examConfiguration.source === source ? 'selected' : ''}>${esc(source)}</option>`).join('')}
      </select></label>` : '';
  const tagOptions = tags.length
    ? `<label class="form-field"><span>Matéria / tag</span><select class="form-control" data-exam-field="tag">
        <option value="">Todas as matérias</option>
        ${tags.map(tag => `<option value="${esc(tag)}" ${examConfiguration.tag === tag ? 'selected' : ''}>${esc(tag)}</option>`).join('')}
      </select></label>` : '';
  main.innerHTML = `<section class="card exam-configuration" aria-labelledby="exam-configuration-title">
    <div class="form-heading"><div><h2 id="exam-configuration-title">Configuração do Simulado</h2>
      <p class="muted">Escolha as questões e o tempo antes de iniciar.</p></div></div>
    <section class="exam-config-section" aria-labelledby="exam-count-title">
      <h3 id="exam-count-title">Número de questões</h3>
      <label class="form-field"><span>Quantidade</span>
        <input class="form-control" data-exam-field="count" type="number" min="1" step="1" value="${esc(examConfiguration.count)}">
      </label>
      <p class="muted" data-exam-available>${pool.length} ${pool.length === 1 ? 'questão disponível' : 'questões disponíveis'} com os filtros atuais.</p>
    </section>
    <section class="exam-config-section" aria-labelledby="exam-time-title">
      <h3 id="exam-time-title">Limite de tempo</h3>
      <label class="question-multichoice-toggle"><input data-exam-field="timed" type="checkbox" ${examConfiguration.timed ? 'checked' : ''}>
        <span>Com limite de tempo</span></label>
      <label class="form-field exam-duration"><span>Duração (minutos)</span>
        <input class="form-control" data-exam-field="minutes" type="number" min="1" step="1" value="${esc(examConfiguration.minutes)}" ${examConfiguration.timed ? '' : 'disabled'}>
      </label>
      <p class="muted">Sem limite de tempo, o simulado não será encerrado automaticamente.</p>
    </section>
    <section class="exam-config-section" aria-labelledby="exam-filters-title">
      <h3 id="exam-filters-title">Filtros de questões</h3>
      <label class="form-field"><span>Conjunto inicial</span><select class="form-control" data-exam-field="selection">
        <option value="all" ${examConfiguration.selection === 'all' ? 'selected' : ''}>Todas as questões</option>
        <option value="errors" ${examConfiguration.selection === 'errors' ? 'selected' : ''}>Apenas banco de erros</option>
        <option value="new" ${examConfiguration.selection === 'new' ? 'selected' : ''}>Apenas questões novas</option>
      </select></label>
      <div class="form-row">${sourceOptions}${tagOptions}</div>
    </section>
    <div class="exam-config-feedback" data-exam-feedback role="alert" hidden></div>
    <div class="actions"><button type="button" class="primary" data-exam-action="start">Iniciar Simulado</button>
      <button type="button" data-exam-action="back">Voltar</button></div>
  </section>`;
}

function render() {
  syncExamTimer();
  renderStats();
  document.body.classList.toggle('settings-view', currentView === 'settings');
  document.body.classList.toggle('exam-configuration-view', currentView === 'exam-configuration');
  const m = $('main');
  if (currentView === 'settings') {
    renderSettings(m);
    return;
  }
  if (currentView === 'exam-configuration') return renderExamConfiguration(m);
  if (currentView === 'statistics') return renderStatistics(m);
  if (currentView === 'bank') return renderQuestionBank(m);
  if (currentView === 'add') return renderQuestionForm(m);
  if (!S) { m.innerHTML = '<p class="muted">Escolha um modo acima para começar.</p>'; return; }
  if (S.done) return renderResult(m);

  const q = byId[S.ids[S.idx]], a = S.answers[q.id], multi = q.type === 'multiple_choice';
  sel = a ? a.sel : [];
  const last = S.idx === S.ids.length - 1;
  const questionSummary = getExamSummary(S);
  const questionMap = `<div class="question-map-shell">
    <div class="question-map-toolbar">
      <button type="button" data-act="toggle-question-map">${questionMapVisible ? 'Ocultar mapa' : 'Mostrar mapa'}</button>
    </div>
    ${questionMapVisible ? `<div class="question-map" aria-label="Mapa das questões">${S.ids.map((id, index) => {
      const answer = S.answers[id];
      const state = !answer ? 'pending' : answer.reviewed ? 'review' : 'answered';
      const current = index === S.idx ? 'current' : '';
      return `<button type="button" data-act="jump" data-question-index="${index}" class="exam-chip ${state} ${current}" aria-label="Ir para a questão ${index + 1}">${index + 1}</button>`;
    }).join('')}</div>` : ''}
  </div>`;
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
  const reviewLabel = a && a.reviewed ? 'Desmarcar revisão' : 'Marcar para revisão';
  m.innerHTML = `<div class="card">
    <div class="meta"><span>Modo: ${MODES[S.mode]}</span><span>Questão ${S.idx + 1} / ${S.ids.length}</span>
      ${S.mode === 'exam' ? `<span class="exam-timer ${getExamTimerClass(S)}" aria-label="${Number.isFinite(S.deadlineAt) ? 'Tempo restante' : 'Tempo decorrido'}">⏱ <time id="examTimer">${Number.isFinite(S.deadlineAt) ? formatExamRemaining(getExamRemainingMs(S)) : formatDuration(getExamElapsedMs(S))}</time></span>` : ''}
    </div>
    <div class="meta"><span>Respondidas: ${questionSummary.answered}/${questionSummary.total}</span><span>Sem resposta: ${questionSummary.unanswered}</span><span>Em revisão: ${questionSummary.reviewed}</span></div>
    ${questionMap}
    <div class="progress"><div style="width:${(S.idx + (a ? 1 : 0)) / S.ids.length * 100}%"></div></div>
    <p class="qtext">${esc(q.question)}</p>
    ${multi ? `<p class="hint">Múltiplas respostas: selecione ${q.correct_answer.length}.</p>` : ''}
    <div id="opts">${opts}</div>${feedback}
    <div class="actions">
      ${S.mode === 'exam' && S.idx > 0 ? '<button data-act="prev">Anterior</button>' : ''}
      ${S.mode === 'exam' ? `<button data-act="toggle-review">${reviewLabel}</button>` : ''}
      ${a ? '' : '<button class="primary" data-act="submit">Responder</button>'}
      ${a ? `<button class="primary" data-act="next">${last ? 'Ver resultado' : 'Próxima'}</button>` : ''}
      ${a && a.ok ? `<button data-act="guess" ${inBank ? 'disabled' : ''}>Acertei por chute</button>` : ''}
      ${S.mode === 'exam' ? '<button class="primary" data-act="finish">Finalizar simulado</button>' : ''}
      <button data-act="quit">Encerrar sessão</button>
    </div></div>`;
}

function percentage(correct, total) {
  return total ? correct / total * 100 : null;
}

function formatPercentage(value) {
  return value === null ? '—' : `${value.toFixed(1).replace('.', ',')}%`;
}

function responseHistory() {
  return (Array.isArray(P.history) ? P.history : [])
    .filter(entry => entry && typeof entry.id === 'string' && typeof entry.ok === 'boolean');
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Data indisponível' : date.toLocaleDateString('pt-BR');
}

function getStatisticsData() {
  const responses = responseHistory();
  const answered = responses.length;
  const correct = responses.filter(entry => entry.ok).length;
  const errorBankQuestions = Q.filter(question =>
    P.questionProgress[question.id] && P.questionProgress[question.id].inErrorBank
  );
  const recoveredIds = new Set(responses
    .filter(entry => entry.ok && entry.mode === 'errors' && entry.wasInErrorBank)
    .map(entry => entry.id));
  const topics = new Map();
  const daily = new Map();

  function addGroup(groups, name, isCorrect) {
    const groupName = name || 'Não informado';
    const group = groups.get(groupName) || { name: groupName, answered: 0, correct: 0, errors: 0 };
    group.answered++;
    if (isCorrect) group.correct++;
    else group.errors++;
    groups.set(groupName, group);
  }

  for (const entry of responses) {
    const question = byId[entry.id];
    addGroup(topics, entry.tag || (question && question.tag), entry.ok);

    const key = dateKey(entry.date);
    if (key) {
      const day = daily.get(key) || { date: key, answered: 0, correct: 0 };
      day.answered++;
      if (entry.ok) day.correct++;
      daily.set(key, day);
    }
  }

  const errorTopics = new Map();
  for (const question of errorBankQuestions) {
    const tag = question.tag || 'Não informado';
    errorTopics.set(tag, (errorTopics.get(tag) || 0) + 1);
  }

  const examAnswers = new Map();
  const completedExams = new Map();
  for (const entry of Array.isArray(P.history) ? P.history : []) {
    if (!entry || typeof entry.sessionId !== 'string') continue;
    if (entry.type === 'exam-completed') {
      completedExams.set(entry.sessionId, entry);
    } else if (entry.mode === 'exam' && typeof entry.id === 'string' && typeof entry.ok === 'boolean') {
      const answers = examAnswers.get(entry.sessionId) || [];
      answers.push(entry);
      examAnswers.set(entry.sessionId, answers);
    }
  }

  const exams = [...completedExams.entries()]
    .map(([sessionId, completion]) => {
      const answers = examAnswers.get(sessionId) || [];
      const examCorrect = answers.filter(entry => entry.ok).length;
      return {
        sessionId,
        date: completion.date,
        durationMs: Number.isFinite(completion.elapsedMs) ? completion.elapsedMs : null,
        completionReason: completion.completionReason,
        answered: answers.length,
        correct: examCorrect,
        errors: answers.length - examCorrect,
        percentage: percentage(examCorrect, answers.length)
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((exam, index) => ({ ...exam, number: index + 1 }));

  return {
    answered,
    correct,
    errors: answered - correct,
    unique: new Set(responses.map(entry => entry.id)).size,
    percentage: percentage(correct, answered),
    errorBankQuestions,
    recoveredIds,
    recoveryPercentage: percentage(recoveredIds.size, recoveredIds.size + errorBankQuestions.length),
    topics: [...topics.values()],
    errorTopics: [...errorTopics.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    exams
  };
}

function renderLineChart(points, label) {
  if (!points.length) return '<p class="muted statistics-empty">Ainda não há respostas suficientes para gerar este gráfico.</p>';
  const left = 42, right = 700, top = 20, bottom = 190;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? (left + right) / 2 : left + (right - left) * index / (points.length - 1);
    const y = bottom - (point.percentage || 0) / 100 * (bottom - top);
    return { x, y, point };
  });
  const line = coords.map(({ x, y }) => `${x},${y}`).join(' ');
  const labels = coords.map(({ x, point }, index) =>
    index === 0 || index === coords.length - 1 || index % Math.ceil(coords.length / 6) === 0
      ? `<text x="${x}" y="218" text-anchor="middle">${esc(point.label)}</text>` : ''
  ).join('');
  return `<div class="statistics-chart"><svg viewBox="0 0 720 240" role="img" aria-label="${esc(label)}">
    <line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" class="chart-axis"/>
    <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" class="chart-axis"/>
    <line x1="${left}" y1="${top + (bottom - top) / 2}" x2="${right}" y2="${top + (bottom - top) / 2}" class="chart-grid"/>
    <text x="4" y="${top + 4}">100%</text><text x="12" y="${(top + bottom) / 2 + 4}">50%</text><text x="26" y="${bottom + 4}">0%</text>
    <polyline points="${line}" class="chart-line"/>
    ${coords.map(({ x, y, point }) => `<circle cx="${x}" cy="${y}" r="4" class="chart-point"><title>${esc(point.label)}: ${formatPercentage(point.percentage)}</title></circle>`).join('')}
    ${labels}
  </svg></div>`;
}

function renderStatistics(main) {
  const data = getStatisticsData();
  const today = new Date();
  let daily = data.daily;
  if (statisticsPeriod !== 'all') {
    const days = Number(statisticsPeriod);
    const firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1);
    const cutoff = dateKey(firstDay);
    daily = daily.filter(day => day.date >= cutoff);
  }
  const dailyPoints = daily.map(day => ({
    label: day.date.slice(8) + '/' + day.date.slice(5, 7),
    percentage: percentage(day.correct, day.answered)
  }));
  const topicRows = data.topics.slice();
  if (statisticsSort.topics === 'highest') topicRows.sort((a, b) => percentage(b.correct, b.answered) - percentage(a.correct, a.answered));
  else if (statisticsSort.topics === 'errors') topicRows.sort((a, b) => b.errors - a.errors);
  else topicRows.sort((a, b) => percentage(a.correct, a.answered) - percentage(b.correct, b.answered));
  const table = (rows, type) => rows.length ? `<div class="statistics-table-wrap"><table class="statistics-table">
    <thead><tr><th>Tópico</th><th>Respondidas</th><th>Acertos</th><th>Erros</th><th>Aproveitamento</th></tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${esc(row.name)}</th><td>${row.answered}</td><td>${row.correct}</td>
      <td>${row.errors}</td><td>${formatPercentage(percentage(row.correct, row.answered))}</td></tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted statistics-empty">Ainda não há respostas suficientes para gerar esta estatística.</p>';

  main.innerHTML = `<section class="statistics-page" aria-labelledby="statistics-title">
    <h2 id="statistics-title">Estatísticas</h2>
    <div class="statistics-summary">
      <article class="card statistics-metric"><span>Respostas registradas</span><strong>${data.answered}</strong></article>
      <article class="card statistics-metric"><span>Acertos</span><strong>${data.correct}</strong></article>
      <article class="card statistics-metric"><span>Erros</span><strong>${data.errors}</strong></article>
      <article class="card statistics-metric"><span>Taxa de acerto</span><strong>${formatPercentage(data.percentage)}</strong></article>
      <article class="card statistics-metric"><span>Questões únicas respondidas</span><strong>${data.unique}</strong></article>
    </div>
    ${data.answered ? '' : '<p class="banner warn statistics-notice">Responda algumas questões para começar a visualizar seu desempenho.</p>'}
    <section class="card statistics-section" aria-labelledby="daily-statistics-title">
      <div class="statistics-section-heading"><h3 id="daily-statistics-title">Evolução da taxa de acerto</h3>
        <label class="statistics-filter">Período
          <select class="form-control" data-stat-filter="period">
            <option value="7" ${statisticsPeriod === '7' ? 'selected' : ''}>Últimos 7 dias</option>
            <option value="30" ${statisticsPeriod === '30' ? 'selected' : ''}>Últimos 30 dias</option>
            <option value="all" ${statisticsPeriod === 'all' ? 'selected' : ''}>Todo o período</option>
          </select>
        </label>
      </div>
      ${renderLineChart(dailyPoints, 'Taxa de acerto por dia')}
    </section>
    <div class="statistics-columns">
      <section class="card statistics-section" aria-labelledby="topic-statistics-title">
        <div class="statistics-section-heading"><h3 id="topic-statistics-title">Desempenho por tópico</h3>
          <label class="statistics-filter topic-statistics-filter">Ordenar
            <select class="form-control" data-stat-filter="topics">
              <option value="lowest" ${statisticsSort.topics === 'lowest' ? 'selected' : ''}>Menor taxa de acerto</option>
              <option value="highest" ${statisticsSort.topics === 'highest' ? 'selected' : ''}>Maior taxa de acerto</option>
              <option value="errors" ${statisticsSort.topics === 'errors' ? 'selected' : ''}>Maior quantidade de erros</option>
            </select>
          </label>
        </div>
        ${table(topicRows, 'topics')}
      </section>
    </div>
    <section class="card statistics-section" aria-labelledby="error-statistics-title">
      <h3 id="error-statistics-title">Banco de Erros</h3>
      <div class="statistics-summary error-statistics-summary">
        <article class="statistics-metric"><span>No banco atualmente</span><strong>${data.errorBankQuestions.length}</strong></article>
        <article class="statistics-metric"><span>Questões recuperadas</span><strong>${data.recoveredIds.size}</strong></article>
        <article class="statistics-metric"><span>Pendentes</span><strong>${data.errorBankQuestions.length}</strong></article>
        <article class="statistics-metric"><span>Taxa de recuperação</span><strong>${formatPercentage(data.recoveryPercentage)}</strong></article>
      </div>
      ${data.errorTopics.length ? `<h4>Tópicos com mais questões no Banco de Erros</h4><ul class="error-topic-list">
        ${data.errorTopics.map(topic => `<li><span>${esc(topic.name)}</span><strong>${topic.count}</strong></li>`).join('')}
      </ul>` : '<p class="muted statistics-empty">O Banco de Erros está vazio.</p>'}
    </section>
    <section class="card statistics-section" aria-labelledby="exam-statistics-title">
      <h3 id="exam-statistics-title">Simulados</h3>
      ${data.exams.length ? `<div class="statistics-columns exam-statistics">
        <div><h4>Evolução do desempenho</h4>${renderLineChart(data.exams.map(exam => ({
          label: `#${exam.number}`, percentage: exam.percentage
        })), 'Taxa de acerto por simulado')}</div>
        <div class="statistics-table-wrap"><table class="statistics-table">
          <thead><tr><th>Simulado</th><th>Data</th><th>Questões</th><th>Acertos</th><th>Erros</th><th>Aproveitamento</th><th>Tempo</th><th>Encerramento</th></tr></thead>
          <tbody>${data.exams.slice().reverse().map(exam => `<tr><th scope="row">#${exam.number}</th><td>${formatDate(exam.date)}</td>
            <td>${exam.answered}</td><td>${exam.correct}</td><td>${exam.errors}</td><td>${formatPercentage(exam.percentage)}</td>
            <td>${exam.durationMs === null ? '—' : formatDuration(exam.durationMs)}</td>
            <td>${exam.completionReason === 'time-expired' ? 'Tempo esgotado' : 'Concluído'}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : '<p class="muted statistics-empty">O histórico de simulados passa a ser registrado a partir desta versão. Conclua um simulado para visualizar o desempenho aqui.</p>'}
    </section>
  </section>`;
}

function renderQuestionForm(main, focus) {
  const editingQuestion = editingQuestionId
    ? bankQuestions.find(question => question && question.id === editingQuestionId)
    : null;
  const tagOptions = [...new Set([
    ...availableTags,
    ...(editingQuestion && editingQuestion.tag && !availableTags.includes(editingQuestion.tag) ? [editingQuestion.tag] : [])
  ])];
  const options = questionDraft.options.map((option, index) => `<div class="option-editor">
    <div class="option-editor-heading">
      <label for="question-option-${index}">Resposta ${index + 1}</label>
      <button type="button" class="remove-option" data-form-action="remove-option" data-index="${index}"
        aria-label="Remover resposta ${index + 1}" title="Remover resposta" ${questionDraft.options.length <= 2 ? 'disabled' : ''}>X</button>
    </div>
    <input class="form-control" id="question-option-${index}" data-question-field="option" data-index="${index}"
      type="text" maxlength="500" value="${esc(option)}" placeholder="Digite uma alternativa" required>
  </div>`).join('');
  const correctAnswerFields = questionDraft.multipleAnswers
    ? questionDraft.correctAnswers.map((answer, answerIndex) => {
      const selectedElsewhere = new Set(questionDraft.correctAnswers.filter((_, index) => index !== answerIndex));
      const choices = questionDraft.options.map((option, optionIndex) => {
        const label = option.trim() || `Resposta ${optionIndex + 1} (preencha o texto)`;
        const value = String(optionIndex);
        const unavailable = selectedElsewhere.has(value);
        return `<option value="${value}" ${answer === value ? 'selected' : ''} ${unavailable ? 'disabled' : ''}>${esc(label)}</option>`;
      }).join('');
      return `<div class="option-editor">
        <div class="option-editor-heading">
          <label for="correct-answer-${answerIndex}">Resposta correta ${answerIndex + 1}</label>
          <button type="button" class="remove-option" data-form-action="remove-correct-answer" data-index="${answerIndex}"
            aria-label="Remover resposta correta ${answerIndex + 1}" title="Remover resposta correta" ${questionDraft.correctAnswers.length <= 1 ? 'disabled' : ''}>X</button>
        </div>
        <select class="form-control" id="correct-answer-${answerIndex}" data-question-field="correctAnswer" data-index="${answerIndex}" required>
          <option value="">Selecione uma resposta</option>${choices}
        </select>
      </div>`;
    }).join('')
    : questionDraft.options.map((option, index) => {
      const label = option.trim() || `Resposta ${index + 1} (preencha o texto)`;
      return `<option value="${index}" ${questionDraft.correctAnswers[0] === String(index) ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  const feedback = questionFeedback ? `<div id="questionFeedback" class="form-feedback ${questionFeedback.type}"
    role="${questionFeedback.type === 'error' ? 'alert' : 'status'}" aria-live="polite">
    <span>${esc(questionFeedback.message)}</span>${questionFeedback.id ? `<strong>ID: ${esc(questionFeedback.id)}</strong>` : ''}
  </div>` : '';
  const duplicateWarning = duplicateMatches ? `<section id="duplicateWarning" class="duplicate-warning" role="alert" aria-labelledby="duplicate-warning-title">
    <h3 id="duplicate-warning-title">⚠️ ${duplicateMatches.length === 1
      ? 'Esta questão parece já existir no banco.'
      : `Foram encontradas ${duplicateMatches.length} questões com o mesmo enunciado.`}</h3>
    <ol>${duplicateMatches.map(question => `<li>
      <p>${esc((question.question || '').slice(0, 240))}${question.question && question.question.length > 240 ? '…' : ''}</p>
      <p class="duplicate-meta">ID: ${esc(question.id)}</p>
      <button type="button" data-form-action="view-duplicate" data-question-id="${esc(question.id)}">Ver questão</button>
    </li>`).join('')}</ol>
    <div class="actions">
      <button type="button" data-form-action="cancel-duplicate">Cancelar</button>
      <button type="button" class="primary" data-form-action="continue-duplicate">Cadastrar mesmo assim</button>
    </div>
  </section>` : '';

  main.innerHTML = `<section class="card question-form-card" aria-labelledby="question-form-title">
    <div class="form-heading">
      <div><h2 id="question-form-title">${editingQuestionId ? 'Editar questão' : 'Adicionar questão'}</h2>
        <p class="muted">${editingQuestionId ? `ID: ${esc(editingQuestionId)}. O ID não pode ser alterado.` : 'O ID será gerado automaticamente.'}</p></div>
      <button type="button" data-form-action="${editingQuestionId ? 'cancel-edit' : 'return'}">${editingQuestionId ? 'Cancelar edição' : 'Voltar ao simulador'}</button>
    </div>
    ${feedback}
    ${duplicateWarning}
    <form id="questionForm" class="question-form" novalidate>
      <div class="form-row">
        <label class="form-field"><span>Assunto/Matéria</span>
          <select class="form-control" data-question-field="tag">
            <option value="" ${questionDraft.tag === '' ? 'selected' : ''}>Sem tag</option>
            ${tagOptions.map(tag => `<option value="${esc(tag)}" ${questionDraft.tag === tag ? 'selected' : ''}>${esc(tag)}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="form-field"><span>Questão</span>
        <textarea class="form-control question-textarea" data-question-field="question" maxlength="10000" placeholder="Digite o enunciado da questão..." required>${esc(questionDraft.question)}</textarea>
      </label>
      <label class="question-multichoice-toggle">
        <input type="checkbox" data-question-field="multipleAnswers" ${questionDraft.multipleAnswers ? 'checked' : ''}>
        <span class="toggle-track" aria-hidden="true"></span>
        <span>Tipo de resposta: múltiplas respostas</span>
      </label>
      <fieldset class="options-fieldset">
        <legend>Alternativas</legend>
        <div class="option-editors">${options}</div>
        <button type="button" data-form-action="add-option" ${questionDraft.options.length >= 26 ? 'disabled title="Limite de 26 alternativas da API"' : ''}>+ Adicionar resposta</button>
      </fieldset>
      <fieldset class="options-fieldset">
        <legend>${questionDraft.multipleAnswers ? 'Respostas corretas' : 'Resposta correta'}</legend>
        <div class="option-editors">${questionDraft.multipleAnswers ? correctAnswerFields : `<label class="form-field">
          <select class="form-control" data-question-field="correctAnswer" data-index="0" required>
            <option value="">Selecione a resposta correta</option>${correctAnswerFields}
          </select>
        </label>`}</div>
        ${questionDraft.multipleAnswers ? `<button type="button" data-form-action="add-correct-answer"
          ${questionDraft.correctAnswers.length >= questionDraft.options.length ? 'disabled title="Cada alternativa pode ser selecionada apenas uma vez"' : ''}>+ Adicionar resposta correta</button>` : ''}
      </fieldset>
      <label class="form-field"><span>Explicação <span class="optional-label">(opcional)</span></span>
        <textarea class="form-control explanation-textarea" data-question-field="explanation" maxlength="10000" placeholder="Explique por que essa é a resposta correta.">${esc(questionDraft.explanation)}</textarea>
      </label>
      ${editingQuestionId ? '' : `<label class="question-multichoice-toggle error-bank-toggle">
        <input type="checkbox" data-question-field="addToErrorBank" ${questionDraft.addToErrorBank ? 'checked' : ''}>
        <span class="toggle-track" aria-hidden="true"></span>
        <span>Adicionar ao Banco de Erros</span>
      </label>`}
      <div class="form-submit-row"><button class="primary" type="submit" ${isSubmittingQuestion ? 'disabled' : ''}>${isSubmittingQuestion ? (editingQuestionId ? 'Salvando...' : 'Enviando...') : (editingQuestionId ? 'Salvar alterações' : 'Adicionar questão')}</button></div>
    </form>
  </section>`;

  if (focus) {
    const field = focus.field === 'option'
      ? main.querySelector(`[data-question-field="option"][data-index="${focus.index}"]`)
      : focus.field === 'correctAnswer'
        ? main.querySelector(`[data-question-field="correctAnswer"][data-index="${focus.index}"]`)
      : main.querySelector(`[data-question-field="${focus.field}"]`);
    if (field) field.focus();
  }
}

function loadQuestionBank() {
  currentView = 'bank';
  bankSelectedId = null;
  bankStatus = 'loading';
  bankError = '';
  const requestVersion = ++bankRequestVersion;
  render();

  Promise.all([
    window.QuestionsApi.getQuestions(),
    window.QuestionsApi.getCatalogStatus()
  ]).then(([questions, status]) => {
    if (requestVersion !== bankRequestVersion || currentView !== 'bank') return;
    bankQuestions = questions;
    renderCatalogNotice(status);
    bankStatus = questions.length ? 'ready' : 'empty';
    renderQuestionBankResults($('bankResults'));
  }).catch(error => {
    if (requestVersion !== bankRequestVersion || currentView !== 'bank') return;
    bankStatus = 'error';
    bankError = error.message;
    renderQuestionBankResults($('bankResults'));
  });
}

async function importQuestionsFromFile(file) {
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    toast('Arquivo de questões inválido. Envie um JSON em formato de lista ou com a propriedade "questions".');
    return;
  }

  const questions = Array.isArray(payload) ? payload : Array.isArray(payload && payload.questions) ? payload.questions : null;
  if (!questions) {
    toast('Arquivo de questões inválido. Envie um JSON em formato de lista ou com a propriedade "questions".');
    return;
  }

  try {
    const summary = await window.QuestionsApi.importQuestions({ questions, confirm: false });
    const total = Number(summary.total ?? questions.length);
    const addable = Number(summary.addable ?? summary.importable ?? 0);
    const duplicates = Number(summary.duplicates ?? 0);
    const invalid = Number(summary.invalid ?? 0);

    const proceed = window.confirm(
      `Resumo da importação:\n\n- Total: ${total}\n- Novas: ${addable}\n- Duplicadas: ${duplicates}\n- Inválidas: ${invalid}\n\nDeseja importar as questões válidas?`
    );
    if (!proceed) return;

    const imported = await window.QuestionsApi.importQuestions({ questions, confirm: true });
    const refreshed = await window.QuestionsApi.getQuestions();
    Q = refreshed.map(question => normalizeQuestion(question));
    byId = Object.fromEntries(Q.map(question => [question.id, question]));
    bankQuestions = refreshed;
    bankStatus = bankQuestions.length ? 'ready' : 'empty';
    currentView = 'bank';
    save();
    render();
    toast(imported.message || `Importadas ${Number(imported.imported ?? addable)} questões.`);
  } catch (error) {
    toast(error.message || 'Não foi possível importar as questões. Verifique o arquivo e tente novamente.');
  }
}

function questionOptions(question) {
  if (Array.isArray(question.options)) return question.options.map(option => String(option));
  if (question.options && typeof question.options === 'object') return Object.values(question.options).map(option => String(option));
  return [];
}

function questionMatchesTag(question, tag) {
  if (!tag) return true;
  if (tag === '__without_tag__') return !question.tag || !question.tag.trim();
  return question.tag === tag;
}

function getFilteredBankQuestions() {
  const search = bankFilters.query.trim().toLocaleLowerCase('pt-BR');
  return bankQuestions.filter(question => {
    if (!questionMatchesTag(question, bankFilters.tag)) return false;
    const progress = P.questionProgress[question.id];
    const inErrorBank = Boolean(progress && progress.inErrorBank);
    if (bankFilters.errorBank === 'in' && !inErrorBank) return false;
    if (bankFilters.errorBank === 'out' && inErrorBank) return false;
    if (!search) return true;
    const searchableText = [
      question.id,
      question.question,
      question.tag,
      ...questionOptions(question)
    ].join(' ').toLocaleLowerCase('pt-BR');
    return searchableText.includes(search);
  });
}

function renderQuestionBank(main) {
  if (bankSelectedId) return renderQuestionBankDetail(main);

  const existingTags = bankQuestions.map(question => question && typeof question.tag === 'string' ? question.tag.trim() : '');
  const tagOptions = normalizeTags([...availableTags, ...existingTags]);
  main.innerHTML = `<section class="question-bank" aria-labelledby="question-bank-title">
    <div class="bank-heading">
      <h2 id="question-bank-title">Banco de Questões</h2>
      <div class="bank-heading-actions">
        <button type="button" data-bank-action="download-template">Baixar modelo</button>
        <button type="button" data-bank-action="export">Exportar banco</button>
        <button type="button" class="primary" data-bank-action="import">Importar questões</button>
        <button type="button" class="danger" data-bank-action="delete-all">Excluir banco</button>
      </div>
    </div>
    <div class="bank-filters">
      <label class="form-field bank-search"><span>Pesquisar questões</span>
        <input class="form-control" type="search" data-bank-filter="query" value="${esc(bankFilters.query)}" placeholder="ID, enunciado, alternativa..." autocomplete="off">
      </label>
      <label class="form-field"><span>Tag</span>
        <select class="form-control" data-bank-filter="tag">
          <option value="">Todas</option>
          <option value="__without_tag__" ${bankFilters.tag === '__without_tag__' ? 'selected' : ''}>Sem tag</option>
          ${tagOptions.map(tag => `<option value="${esc(tag)}" ${bankFilters.tag === tag ? 'selected' : ''}>${esc(tag)}</option>`).join('')}
        </select>
      </label>
      <label class="form-field"><span>Banco de erros</span>
        <select class="form-control" data-bank-filter="errorBank">
          <option value="" ${bankFilters.errorBank === '' ? 'selected' : ''}>Todas</option>
          <option value="in" ${bankFilters.errorBank === 'in' ? 'selected' : ''}>Apenas no banco de erros</option>
          <option value="out" ${bankFilters.errorBank === 'out' ? 'selected' : ''}>Fora do banco de erros</option>
        </select>
      </label>
    </div>
    <div id="bankResults" aria-live="polite"></div>
  </section>`;
  renderQuestionBankResults($('bankResults'));
}

function renderQuestionBankResults(container) {
  if (!container) return;
  if (bankStatus === 'loading') {
    container.innerHTML = '<p class="bank-state muted" role="status">Carregando questões...</p>';
    return;
  }
  if (bankStatus === 'error') {
    container.innerHTML = `<div class="banner err bank-state" role="alert">
      <p><b>Não foi possível carregar as questões.</b></p>
      <p>Verifique se o servidor está funcionando e tente novamente.</p>
      <button type="button" data-bank-action="retry">Tentar novamente</button>
    </div>`;
    return;
  }
  if (bankStatus === 'empty') {
    container.innerHTML = '<p class="bank-state muted">Nenhuma questão cadastrada.</p>';
    return;
  }

  const questions = getFilteredBankQuestions();
  const countLabel = `${questions.length} ${questions.length === 1 ? 'questão encontrada' : 'questões encontradas'}`;
  if (!questions.length) {
    container.innerHTML = `<div class="bank-results-heading"><p aria-live="polite">${countLabel}</p>
      <button type="button" class="link" data-bank-action="clear-filters">Limpar filtros</button></div>
      <p class="bank-state muted">Nenhuma questão encontrada. Tente alterar os termos da pesquisa ou remover os filtros.</p>`;
    return;
  }

  container.innerHTML = `<div class="bank-results-heading"><p aria-live="polite">${countLabel}</p></div>
    <div class="bank-list">${questions.map(question => `<article class="card bank-item">
      <div class="bank-item-id">${esc(question.id || 'Sem ID')}</div>
      <div class="bank-item-meta">${esc(question.tag || 'Sem tag')}</div>
      <p class="bank-item-question">${esc(question.question || 'Questão sem enunciado')}</p>
      <div class="actions"><button type="button" class="primary" data-bank-action="open" data-question-id="${esc(question.id || '')}">Ver questão</button></div>
    </article>`).join('')}</div>`;
}

function exportQuestionBank() {
  const payload = `${JSON.stringify(bankQuestions, null, 2)}\n`;
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'question-bank.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Banco de questões exportado.');
}

async function deleteQuestionBank() {
  if (!bankQuestions.length || !confirm(
    'Excluir todo o Banco de Questões?\n\nTodas as questões serão removidas da lista. Questões padrão poderão ser restauradas posteriormente.'
  )) return;

  try {
    const result = await window.QuestionsApi.deleteAllQuestions();
    bankQuestions = [];
    Q = [];
    byId = {};
    bankSelectedId = null;
    bankStatus = 'empty';
    S = null;
    renderCatalogNotice(await window.QuestionsApi.getCatalogStatus());
    save();
    render();
    toast(`${result.deletedCount} questão(ões) excluída(s).`);
  } catch (error) {
    toast(error.message || 'Não foi possível excluir o banco de questões.');
  }
}

function renderQuestionBankDetail(main) {
  const question = bankQuestions.find(item => item && item.id === bankSelectedId);
  if (!question) {
    bankSelectedId = null;
    return renderQuestionBank(main);
  }

  const normalized = normalizeQuestion(question);
  const options = Object.entries(normalized.options).map(([letter, text]) => ({ letter, text: String(text) }));
  const correctAnswers = Array.isArray(normalized.correct_answer) ? normalized.correct_answer : [];
  const isCorrect = option => correctAnswers.some(answer =>
    String(answer).toUpperCase() === option.letter || normalizeText(answer).toLocaleLowerCase('pt-BR') === normalizeText(option.text).toLocaleLowerCase('pt-BR')
  );
  const correctTexts = options.filter(isCorrect).map(option => `${option.letter}. ${option.text}`);
  const correctAnswer = correctTexts.length ? correctTexts.join(' · ') : question.correct_answer;
  const explanation = typeof question.explanation === 'string' ? question.explanation.trim() : '';
  const inErrorBank = Boolean(P.questionProgress[question.id] && P.questionProgress[question.id].inErrorBank);

  main.innerHTML = `<section class="card bank-detail" aria-labelledby="bank-detail-title">
    <button type="button" class="link bank-back" data-bank-action="back">← Voltar para Banco de Questões</button>
    ${bankDeleteError ? `<p class="form-feedback error" role="alert">${esc(bankDeleteError)}</p>` : ''}
    <h2 id="bank-detail-title" class="bank-detail-id">${esc(question.id || 'Sem ID')}</h2>
    <dl class="bank-detail-meta">
      <div><dt>Tag</dt><dd>${esc(question.tag || 'Sem tag')}</dd></div>
    </dl>
    <section class="bank-detail-section"><h3>Questão</h3><p class="bank-detail-question">${esc(question.question || '')}</p></section>
    <section class="bank-detail-section"><h3>Alternativas</h3>
      <ol class="bank-option-list">${options.map(option => `<li class="${isCorrect(option) ? 'correct' : ''}">
        <span class="bank-option-letter">${esc(option.letter)}.</span><span>${esc(option.text)}</span>${isCorrect(option) ? '<strong>Correta</strong>' : ''}
      </li>`).join('')}</ol>
    </section>
    <section class="bank-detail-section"><h3>Resposta correta</h3><p class="bank-correct-answer">${esc(correctAnswer || 'Não informada')}</p></section>
    ${explanation ? `<section class="bank-detail-section"><h3>Explicação</h3><p class="bank-explanation">${esc(explanation)}</p></section>` : ''}
    <div class="bank-detail-actions">
      <button type="button" data-bank-action="edit" ${isDeletingQuestion ? 'disabled' : ''}>Editar questão</button>
      ${selectedQuestionMetadata && selectedQuestionMetadata.origin === 'catalog' && selectedQuestionMetadata.hasOverride
        ? `<button type="button" data-bank-action="restore-default" ${isRestoringQuestion ? 'disabled' : ''}>Restaurar versão padrão</button>`
        : ''}
      <span class="error-bank-status ${inErrorBank ? 'in-bank' : ''}" role="status">${inErrorBank ? '✓ No Banco de Erros' : 'Fora do Banco de Erros'}</span>
      <button type="button" data-bank-action="toggle-error-bank" ${isDeletingQuestion ? 'disabled' : ''}>
        ${inErrorBank ? 'Remover do Banco de Erros' : 'Adicionar ao Banco de Erros'}
      </button>
      <button type="button" class="danger" data-bank-action="delete" ${isDeletingQuestion ? 'disabled' : ''}>
        ${isDeletingQuestion ? 'Excluindo...' : 'Excluir questão'}
      </button>
    </div>
  </section>`;
}

async function openQuestionBankQuestion(id) {
  if (!id || !bankQuestions.some(question => question && question.id === id)) return;
  bankListScrollY = window.scrollY;
  bankSelectedId = id;
  selectedQuestionMetadata = null;
  renderQuestionBank($('main'));
  window.scrollTo(0, 0);
  try {
    selectedQuestionMetadata = await window.QuestionsApi.getQuestionMetadata(id);
    if (bankSelectedId === id && currentView === 'bank') renderQuestionBankDetail($('main'));
  } catch (error) {
    toast(error.message || 'Não foi possível verificar se a questão possui uma edição local.');
  }
}

async function restoreQuestionToDefault(id) {
  if (!id || isRestoringQuestion) return;
  if (!confirm(`Restaurar a questão ${id} para a versão padrão atual?\n\nA edição local será removida.`)) return;
  isRestoringQuestion = true;
  try {
    const restored = await window.QuestionsApi.restoreDefaultQuestion(id);
    const questions = await window.QuestionsApi.getQuestions();
    bankQuestions = questions;
    Q = questions.map(question => normalizeQuestion(question));
    byId = Object.fromEntries(Q.map(question => [question.id, question]));
    catalogStatus = await window.QuestionsApi.getCatalogStatus();
    renderCatalogNotice(catalogStatus);
    selectedQuestionMetadata = await window.QuestionsApi.getQuestionMetadata(id);
    isRestoringQuestion = false;
    if (currentView === 'bank') {
      bankStatus = bankQuestions.length ? 'ready' : 'empty';
      renderQuestionBank($('main'));
    }
    toast(`Questão ${restored.id} restaurada para a versão padrão.`);
  } catch (error) {
    isRestoringQuestion = false;
    if (currentView === 'bank') renderQuestionBank($('main'));
    toast(error.message || 'Não foi possível restaurar a versão padrão da questão.');
  }
}

function returnToQuestionBankList() {
  bankDeleteError = '';
  bankSelectedId = null;
  renderQuestionBank($('main'));
  window.scrollTo(0, bankListScrollY);
}

function startEditingQuestion(id) {
  const question = bankQuestions.find(item => item && item.id === id);
  if (!question) return;

  const normalized = normalizeQuestion(question);
  const options = Object.entries(normalized.options);
  const correctAnswers = normalized.correct_answer.map(answer => options.findIndex(([letter]) => letter === answer))
    .filter(index => index >= 0)
    .map(String);
  questionDraft = {
    tag: question.tag || '',
    question: question.question || '',
    options: options.length ? options.map(([, text]) => String(text)) : ['', ''],
    multipleAnswers: normalized.type === 'multiple_choice',
    correctAnswers: correctAnswers.length ? correctAnswers : [''],
    explanation: typeof question.explanation === 'string' ? question.explanation : ''
  };
  editingQuestionId = id;
  questionFeedback = null;
  isSubmittingQuestion = false;
  currentView = 'add';
  renderQuestionForm($('main'));
  window.scrollTo(0, 0);
}

async function deleteQuestionFromBank(id) {
  const question = bankQuestions.find(item => item && item.id === id);
  if (!question || isDeletingQuestion) return;
  if (!confirm(`Excluir a questão ${id}?\n\nQuestões padrão poderão ser restauradas no Banco de Questões.`)) return;

  bankDeleteError = '';
  isDeletingQuestion = true;
  renderQuestionBankDetail($('main'));

  try {
    await window.QuestionsApi.deleteQuestion(id);
    bankQuestions = bankQuestions.filter(item => item && item.id !== id);
    Q = Q.filter(item => item.id !== id);
    delete byId[id];

    if (S && Array.isArray(S.ids)) {
      const sessionIndex = S.ids.indexOf(id);
      if (sessionIndex !== -1) {
        S.ids.splice(sessionIndex, 1);
        if (!S.ids.length) S = null;
        else if (sessionIndex < S.idx || S.idx >= S.ids.length) S.idx = Math.min(S.idx, S.ids.length - 1);
      }
    }

    isDeletingQuestion = false;
    bankDeleteError = '';
    bankSelectedId = null;
    bankStatus = bankQuestions.length ? 'ready' : 'empty';
    try {
      renderCatalogNotice(await window.QuestionsApi.getCatalogStatus());
    } catch (statusError) {
      toast(statusError.message || 'A questão foi excluída, mas não foi possível atualizar o relatório do catálogo.');
    }
    save();
    render();
    window.scrollTo(0, bankListScrollY);
    toast(`Questão ${id} excluída.`);
  } catch (error) {
    isDeletingQuestion = false;
    bankDeleteError = error.message || 'Não foi possível excluir a questão. Tente novamente.';
    renderQuestionBankDetail($('main'));
  }
}

function cancelQuestionEdit() {
  const id = editingQuestionId;
  editingQuestionId = null;
  questionDraft = createQuestionDraft();
  questionFeedback = null;
  currentView = 'bank';
  bankSelectedId = id;
  render();
  window.scrollTo(0, 0);
}

function refreshCorrectAnswerOptions() {
  $('main').querySelectorAll('[data-question-field="correctAnswer"]').forEach(select => {
    const answerIndex = Number(select.dataset.index);
    const selected = questionDraft.correctAnswers[answerIndex];
    const selectedElsewhere = new Set(questionDraft.correctAnswers.filter((_, index) => index !== answerIndex));
    select.innerHTML = `<option value="">Selecione uma resposta</option>${questionDraft.options.map((option, index) => {
      const label = option.trim() || `Resposta ${index + 1} (preencha o texto)`;
      const value = String(index);
      return `<option value="${value}" ${selected === value ? 'selected' : ''} ${selectedElsewhere.has(value) ? 'disabled' : ''}>${esc(label)}</option>`;
    }).join('')}`;
  });
}

function clearQuestionFeedback() {
  questionFeedback = null;
  duplicateMatches = null;
  const feedback = $('questionFeedback');
  if (feedback) feedback.remove();
  const duplicateWarning = $('duplicateWarning');
  if (duplicateWarning) duplicateWarning.remove();
}

function validateQuestionDraft() {
  const original = editingQuestionId ? bankQuestions.find(question => question && question.id === editingQuestionId) : null;
  if (questionDraft.tag && !availableTags.includes(questionDraft.tag) && questionDraft.tag !== original?.tag) return 'Selecione uma tag válida.';
  if (!questionDraft.question.trim()) return 'Preencha o enunciado da questão.';
  if (questionDraft.options.length < 2) return 'Adicione pelo menos duas alternativas.';
  if (questionDraft.options.some(option => !option.trim())) return 'Preencha todas as alternativas.';
  const normalizedOptions = questionDraft.options.map(option => option.trim().toLocaleLowerCase('pt-BR'));
  if (new Set(normalizedOptions).size !== normalizedOptions.length) return 'As alternativas não podem ser duplicadas.';
  if (!questionDraft.correctAnswers.length) return 'Selecione pelo menos uma resposta correta.';
  if (questionDraft.correctAnswers.some(answer => answer === '' || !questionDraft.options[Number(answer)])) return 'Selecione todas as respostas corretas.';
  if (new Set(questionDraft.correctAnswers).size !== questionDraft.correctAnswers.length) return 'As respostas corretas não podem ser duplicadas.';
  return '';
}

async function submitQuestion(event, allowDuplicate = false) {
  if (event) event.preventDefault();
  if (isSubmittingQuestion) return;

  const validationMessage = validateQuestionDraft();
  if (validationMessage) {
    questionFeedback = { type: 'error', message: validationMessage };
    return renderQuestionForm($('main'));
  }

  duplicateMatches = null;
  const correctAnswers = questionDraft.correctAnswers.map(index => String.fromCharCode(65 + Number(index)));
  const payload = {
    tag: questionDraft.tag,
    question: questionDraft.question.trim(),
    options: questionDraft.options.map(option => option.trim()),
    correct_answer: questionDraft.multipleAnswers ? correctAnswers : correctAnswers[0],
    explanation: questionDraft.explanation.trim()
  };

  isSubmittingQuestion = true;
  questionFeedback = { type: 'pending', message: editingQuestionId ? 'Salvando alterações...' : 'Verificando possíveis duplicatas...' };
  renderQuestionForm($('main'));

  try {
    const wasEditing = Boolean(editingQuestionId);
    if (!wasEditing && !allowDuplicate) {
      const existingQuestions = await window.QuestionsApi.getQuestions();
      duplicateMatches = findDuplicateQuestions(payload.question, existingQuestions);
      if (duplicateMatches.length) {
        questionFeedback = null;
        isSubmittingQuestion = false;
        renderQuestionForm($('main'));
        return;
      }
    }

    const saved = wasEditing
      ? await window.QuestionsApi.updateQuestion(editingQuestionId, payload)
      : await window.QuestionsApi.createQuestion(payload);
    const normalized = normalizeQuestion(saved);
    if (wasEditing) {
      bankQuestions = bankQuestions.map(question => question && question.id === saved.id ? saved : question);
      Q = Q.map(question => question.id === saved.id ? normalized : question);
      byId[saved.id] = normalized;
      if (S && !S.done && S.ids[S.idx] === saved.id) sel = [];
      bankSelectedId = saved.id;
      try {
        selectedQuestionMetadata = await window.QuestionsApi.getQuestionMetadata(saved.id);
        renderCatalogNotice(await window.QuestionsApi.getCatalogStatus());
      } catch (statusError) {
        toast(statusError.message || 'A questão foi salva, mas não foi possível atualizar seus metadados.');
      }
      editingQuestionId = null;
      duplicateMatches = null;
      currentView = 'bank';
      bankDeleteError = '';
      isSubmittingQuestion = false;
      save();
      render();
      window.scrollTo(0, 0);
      toast(`Questão ${saved.id} atualizada.`);
      return;
    }

    Q.push(normalized);
    byId[normalized.id] = normalized;
    const shouldAddToErrorBank = questionDraft.addToErrorBank;
    const addedToErrorBank = !shouldAddToErrorBank || setErrorBankMembership(normalized.id, true, false);
    questionDraft = createQuestionDraft();
    duplicateMatches = null;
    questionFeedback = addedToErrorBank
      ? { type: 'success', message: 'Questão adicionada com sucesso!', id: saved.id }
      : { type: 'error', message: 'A questão foi criada, mas não foi possível adicioná-la ao Banco de Erros. Você pode tentar novamente na visualização da questão.', id: saved.id };
    isSubmittingQuestion = false;
    renderStats();
    renderQuestionForm($('main'), { field: 'question' });
    if (addedToErrorBank && shouldAddToErrorBank) toast('Questão adicionada ao Banco de Erros.');
    else if (!addedToErrorBank) toast('A questão foi criada, mas não foi possível adicioná-la ao Banco de Erros.');
  } catch (error) {
    questionFeedback = { type: 'error', message: error.message || `Não foi possível ${editingQuestionId ? 'salvar as alterações' : 'adicionar a questão'}. Verifique os dados e tente novamente.` };
    isSubmittingQuestion = false;
    renderQuestionForm($('main'));
  }
}

function renderResult(m) {
  const summary = getExamSummary(S);
  const n = summary.total;
  const right = summary.correct;
  const wrong = summary.errors;
  const unanswered = summary.unanswered;
  const reviewed = S.ids.filter(id => S.answers[id] && S.answers[id].reviewed);
  const completionLabel = S.completionReason === 'time-expired' ? 'Tempo esgotado' : 'Finalização manual';
  m.innerHTML = `<div class="card"><h2>Resultado — ${MODES[S.mode]}</h2>
    <p><b>${right} / ${n}</b> acertos (${String((summary.percent || 0)).replace('.', ',')}%)</p>
    <p><b>Data:</b> ${Number.isFinite(S.startedAt) ? new Date(S.startedAt).toLocaleString('pt-BR') : new Date().toLocaleString('pt-BR')}</p>
    <p><b>Duração:</b> ${S.mode === 'exam' && Number.isFinite(S.elapsedMs) ? formatDuration(S.elapsedMs) : 'Não disponível'}</p>
    <p><b>Limite:</b> ${Number.isFinite(S.durationMs) ? formatDuration(S.durationMs) : 'Sem limite'}</p>
    <p><b>Motivo:</b> ${completionLabel}</p>
    <p><b>Respondidas:</b> ${summary.answered} / ${n} &nbsp; | &nbsp; <b>Não respondidas:</b> ${unanswered} &nbsp; | &nbsp; <b>Marcadas para revisão:</b> ${reviewed.length}</p>
    ${S.completionReason === 'time-expired' ? '<p class="result bad"><b>Tempo esgotado.</b> O simulado foi finalizado automaticamente.</p>' : ''}
    ${wrong ? `<p>Questões erradas:</p><ol class="wrong-list">${S.ids.filter(id => S.answers[id] && !S.answers[id].ok).map(id => `<li>${esc(byId[id].question.slice(0, 140))}</li>`).join('')}</ol>`
      : unanswered ? '<p>Nenhuma resposta incorreta.</p>' : '<p>Nenhum erro. Ótimo!</p>'}
    ${reviewed.length ? `<p>Questões marcadas para revisão:</p><ul class="wrong-list">${reviewed.map(id => `<li>${esc(byId[id].question.slice(0, 140))}</li>`).join('')}</ul>` : ''}
    <div class="actions">
      <button data-act="review">Revisar questões</button>
      <button class="primary" data-act="quit">Voltar ao início</button>
      <button data-act="start-another">Iniciar outro simulado</button>
    </div></div>`;
}

/* ---------- Cadastro de questões ---------- */
$('main').addEventListener('input', e => {
  if (currentView === 'bank' && e.target.dataset.bankFilter === 'query') {
    bankFilters.query = e.target.value;
    renderQuestionBankResults($('bankResults'));
    return;
  }
  const field = e.target.dataset.questionField;
  if (!field || currentView !== 'add') return;
  if (field === 'addToErrorBank') return;
  if (field === 'option') {
    questionDraft.options[Number(e.target.dataset.index)] = e.target.value;
    refreshCorrectAnswerOptions();
  } else if (field === 'correctAnswer') {
    questionDraft.correctAnswers[Number(e.target.dataset.index)] = e.target.value;
    clearQuestionFeedback();
    renderQuestionForm($('main'));
    return;
  } else if (field === 'multipleAnswers') {
    return;
  } else {
    questionDraft[field] = e.target.value;
  }
  clearQuestionFeedback();
});

$('main').addEventListener('change', e => {
  if (currentView === 'bank' && e.target.dataset.bankFilter) {
    bankFilters[e.target.dataset.bankFilter] = e.target.value;
    renderQuestionBankResults($('bankResults'));
    return;
  }
  const statisticsFilter = e.target.dataset.statFilter;
  if (statisticsFilter === 'period') {
    statisticsPeriod = e.target.value;
    return renderStatistics($('main'));
  }
  if (statisticsFilter === 'topics') {
    statisticsSort[statisticsFilter] = e.target.value;
    return renderStatistics($('main'));
  }
  const field = e.target.dataset.questionField;
  if (!field || currentView !== 'add') return;
  if (field === 'multipleAnswers') {
    if (!e.target.checked && questionDraft.correctAnswers.filter(Boolean).length > 1) {
      e.target.checked = true;
      return toast('Remova as respostas corretas extras antes de voltar para resposta única.');
    }
    questionDraft.multipleAnswers = e.target.checked;
    if (!e.target.checked) questionDraft.correctAnswers = [questionDraft.correctAnswers.find(Boolean) || ''];
  } else if (field === 'addToErrorBank') {
    questionDraft.addToErrorBank = e.target.checked;
  } else if (field === 'correctAnswer') {
    questionDraft.correctAnswers[Number(e.target.dataset.index)] = e.target.value;
  } else {
    questionDraft[field] = e.target.value;
  }
  clearQuestionFeedback();
  if (field === 'multipleAnswers' || field === 'correctAnswer') renderQuestionForm($('main'));
});

$('main').addEventListener('submit', e => {
  if (e.target.id === 'questionForm') submitQuestion(e);
  if (e.target.id === 'tagForm') {
    e.preventDefault();
    const input = e.target.elements.tag;
    const tag = input.value.trim();
    const duplicate = availableTags.some(item => item.toLocaleLowerCase('pt-BR') === tag.toLocaleLowerCase('pt-BR'));
    const feedback = $('settingsTagFeedback');
    if (!tag) {
      feedback.textContent = 'Informe um nome de tag.';
      feedback.hidden = false;
      return;
    }
    if (duplicate) {
      feedback.textContent = 'Essa tag já está cadastrada.';
      feedback.hidden = false;
      return;
    }
    persistTags([...availableTags, tag]).then(() => {
      renderSettings($('main'));
      toast('Tag adicionada.');
    }).catch(error => {
      feedback.textContent = error.message || 'Não foi possível salvar a tag.';
      feedback.hidden = false;
    });
  }
});

/* ---------- Eventos ---------- */
$('main').addEventListener('change', e => {
  const examField = e.target.dataset.examField;
  if (examField) {
    if (examField === 'count' || examField === 'minutes') examConfiguration[examField] = Number(e.target.value);
    else if (examField === 'timed') examConfiguration.timed = e.target.checked;
    else examConfiguration[examField] = e.target.value;
    renderExamConfiguration($('main'));
    return;
  }
  if (e.target.name !== 'opt') return;
  if (S && !S.done && isExamExpired(S)) {
    finishExam('time-expired');
    return;
  }
  const q = byId[S.ids[S.idx]];
  if (q.type === 'single_choice') sel = [e.target.value];
  else sel = [...document.querySelectorAll('#opts input:checked')].map(i => i.value);
  document.querySelectorAll('#opts .opt').forEach(l => l.classList.toggle('picked', sel.includes(l.querySelector('input').value)));

  if (S && !S.done) {
    const current = S.answers[q.id] || { sel: [], ok: false, reviewed: false };
    S.answers[q.id] = { ...current, sel: sel.slice(), reviewed: Boolean(current.reviewed) };
    save();
  }
});

$('main').addEventListener('click', async e => {
  const examAction = e.target.closest('[data-exam-action]');
  if (examAction) {
    if (examAction.dataset.examAction === 'back') {
      currentView = 'simulator';
      render();
      return;
    }
    const count = examConfiguration.count;
    const minutes = examConfiguration.minutes;
    const pool = getExamPool(examConfiguration);
    const feedback = $('main').querySelector('[data-exam-feedback]');
    const showFeedback = message => {
      feedback.textContent = message;
      feedback.hidden = false;
    };
    if (!Number.isSafeInteger(count) || count <= 0) {
      showFeedback('Informe uma quantidade inteira e positiva de questões.');
      return;
    }
    if (examConfiguration.timed && (!Number.isSafeInteger(minutes) || minutes <= 0)) {
      showFeedback('Informe uma duração inteira e positiva em minutos.');
      return;
    }
    if (!pool.length) {
      const modeMessage = examConfiguration.selection === 'errors'
        ? 'Não há questões no Banco de Erros para os filtros selecionados.'
        : examConfiguration.selection === 'new'
          ? 'Não há questões novas para os filtros selecionados.'
          : 'Não há questões disponíveis para os filtros selecionados.';
      showFeedback(modeMessage);
      return;
    }
    if (count > pool.length) {
      showFeedback(`A configuração solicita ${count} questões, mas apenas ${pool.length} estão disponíveis após os filtros.`);
      return;
    }
    if (examAction.dataset.examAction === 'start') start('exam', { ...examConfiguration });
    return;
  }
  const settingsAction = e.target.closest('[data-settings-action]');
  if (settingsAction) {
    if (settingsAction.dataset.settingsAction === 'back') {
      currentView = viewBeforeSettings;
      render();
    } else if (settingsAction.dataset.settingsAction === 'remove-tag') {
      const tag = settingsAction.dataset.tag;
      availableTags = availableTags.filter(item => item !== tag);
      try {
        await persistTags(availableTags);
        renderSettings($('main'));
      } catch (error) {
        availableTags.push(tag);
        toast(error.message || 'Não foi possível remover a tag.');
      }
    }
    return;
  }

  const bankAction = e.target.closest('[data-bank-action]');
  if (bankAction) {
    if (bankAction.dataset.bankAction === 'open') await openQuestionBankQuestion(bankAction.dataset.questionId);
    else if (bankAction.dataset.bankAction === 'back') returnToQuestionBankList();
    else if (bankAction.dataset.bankAction === 'download-template') {
      const link = document.createElement('a');
      link.href = 'examples/question-bank-import.json';
      link.download = 'question-bank-import.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    else if (bankAction.dataset.bankAction === 'export') exportQuestionBank();
    else if (bankAction.dataset.bankAction === 'delete-all') await deleteQuestionBank();
    else if (bankAction.dataset.bankAction === 'edit') startEditingQuestion(bankSelectedId);
    else if (bankAction.dataset.bankAction === 'delete') deleteQuestionFromBank(bankSelectedId);
    else if (bankAction.dataset.bankAction === 'restore-default'
      || bankAction.dataset.bankAction === 'restore-deleted') {
      await restoreQuestionToDefault(bankAction.dataset.questionId || bankSelectedId);
    }
    else if (bankAction.dataset.bankAction === 'toggle-error-bank') {
      if (await setErrorBankMembership(bankSelectedId, !(P.questionProgress[bankSelectedId] && P.questionProgress[bankSelectedId].inErrorBank))) {
        renderQuestionBankDetail($('main'));
      }
    }
    else if (bankAction.dataset.bankAction === 'retry') loadQuestionBank();
    else if (bankAction.dataset.bankAction === 'import') {
      $('bankImportFile').click();
    }
    else if (bankAction.dataset.bankAction === 'clear-filters') {
      bankFilters = { query: '', tag: '', errorBank: '' };
      $('main').querySelector('[data-bank-filter="query"]').value = '';
      $('main').querySelector('[data-bank-filter="tag"]').value = '';
      $('main').querySelector('[data-bank-filter="errorBank"]').value = '';
      renderQuestionBankResults($('bankResults'));
    }
    return;
  }

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
      questionDraft.correctAnswers = questionDraft.correctAnswers
        .map(answer => answer === String(removedIndex) ? '' : Number(answer) > removedIndex ? String(Number(answer) - 1) : answer);
      clearQuestionFeedback();
      renderQuestionForm($('main'), { field: 'option', index: Math.max(0, removedIndex - 1) });
    } else if (action === 'add-correct-answer' && questionDraft.correctAnswers.length < questionDraft.options.length) {
      questionDraft.correctAnswers.push('');
      clearQuestionFeedback();
      renderQuestionForm($('main'), { field: 'correctAnswer', index: questionDraft.correctAnswers.length - 1 });
    } else if (action === 'remove-correct-answer' && questionDraft.correctAnswers.length > 1) {
      questionDraft.correctAnswers.splice(Number(formAction.dataset.index), 1);
      clearQuestionFeedback();
      renderQuestionForm($('main'));
    } else if (action === 'cancel-edit') {
      cancelQuestionEdit();
    } else if (action === 'cancel-duplicate') {
      duplicateMatches = null;
      renderQuestionForm($('main'));
      $('main').querySelector('[data-question-field="question"]').focus();
    } else if (action === 'continue-duplicate') {
      submitQuestion(null, true);
    } else if (action === 'view-duplicate') {
      const duplicateId = formAction.dataset.questionId;
      if (duplicateMatches && duplicateMatches.some(question => question.id === duplicateId)) {
        bankQuestions = duplicateMatches;
        bankStatus = 'ready';
        bankSelectedId = duplicateId;
        duplicateMatches = null;
        currentView = 'bank';
        render();
        window.scrollTo(0, 0);
      }
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
  if (!S.done && isExamExpired(S)) {
    finishExam('time-expired');
    return;
  }
  const q = S.done ? null : byId[S.ids[S.idx]];
  if (act === 'submit') {
    if (!sel.length) return toast('Selecione uma alternativa.');
    const ok = sameSet(sel, q.correct_answer);
    S.answers[q.id] = { ...(S.answers[q.id] || {}), sel: sel.slice(), ok, reviewed: Boolean(S.answers[q.id]?.reviewed) };
    record(q, ok); save(); render();
  } else if (act === 'next') {
    if (S.idx < S.ids.length - 1) S.idx++;
    else {
      if (S.mode === 'exam') return finishExam('completed');
      S.done = true;
    }
    save(); render();
  } else if (act === 'prev') {
    S.idx--; save(); render();
  } else if (act === 'jump') {
    const index = Number(e.target.closest('[data-act="jump"]').dataset.questionIndex);
    if (Number.isInteger(index) && index >= 0 && index < S.ids.length) {
      S.idx = index;
      save(); render();
    }
  } else if (act === 'toggle-question-map') {
    questionMapVisible = !questionMapVisible;
    render();
  } else if (act === 'toggle-review') {
    const current = S.answers[q.id] || { sel: [], ok: false, reviewed: false };
    current.reviewed = !current.reviewed;
    S.answers[q.id] = current;
    save(); render();
    toast(current.reviewed ? 'Questão marcada para revisão.' : 'Marca de revisão removida.');
  } else if (act === 'finish') {
    const summary = getExamSummary(S);
    const confirmed = confirm(`Finalizar simulado?\n\nRespondidas: ${summary.answered}/${summary.total}\nSem resposta: ${summary.unanswered}\nEm revisão: ${summary.reviewed}\n\nQuestões não respondidas serão consideradas incorretas.`);
    if (!confirmed) return;
    finishExam('manual');
  } else if (act === 'review') {
    const reviewedIds = S.ids.filter(id => S.answers[id] && S.answers[id].reviewed);
    if (!reviewedIds.length) return toast('Nenhuma questão foi marcada para revisão.');
    const id = reviewedIds[0];
    S.idx = S.ids.indexOf(id);
    save(); render();
  } else if (act === 'guess') {
    if (await setErrorBankMembership(q.id, true, false)) {
      render();
      toast('Questão adicionada ao Banco de Erros.');
    }
  } else if (act === 'quit') {
    if (!S.done && !confirm('Encerrar a sessão atual? As respostas já enviadas continuam salvas.')) return;
    S = null; save(); render();
  } else if (act === 'start-another') {
    S = null; save(); currentView = 'simulator'; render();
  }
});

$('catalogNotice').addEventListener('click', async event => {
  if (!event.target.closest('[data-catalog-action="acknowledge"]')) return;
  try {
    renderCatalogNotice(await window.QuestionsApi.acknowledgeCatalogUpdate());
    toast('Relatório de atualização do catálogo registrado.');
  } catch (error) {
    toast(error.message || 'Não foi possível registrar a revisão do catálogo.');
  }
});

document.querySelector('nav').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.view === 'bank') {
    loadQuestionBank();
  } else if (button.dataset.view === 'add') {
    currentView = 'add';
    render();
  } else if (button.dataset.view === 'statistics') {
    currentView = 'statistics';
    render();
  } else if (button.dataset.mode === 'exam' && Q.length) {
    examConfiguration = { ...examConfiguration, count: Math.min(examConfiguration.count, Q.length) || Q.length };
    currentView = 'exam-configuration';
    render();
  } else if (button.dataset.mode && Q.length) {
    currentView = 'simulator';
    start(button.dataset.mode);
  }
});

$('settingsBtn').addEventListener('click', () => {
  viewBeforeSettings = currentView;
  currentView = 'settings';
  render();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S && S.mode === 'exam' && !S.done) syncExamTimer();
});

/* ---------- Backup, restauração e reset ---------- */
$('fullBackupBtn').onclick = async () => {
  try {
    await progressSaveQueue;
    const backup = await window.QuestionsApi.createBackup(P);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const uniqueSuffix = Math.random().toString(36).slice(2, 8);
    link.download = `aws-clf-c02-backup-${backup.exportedAt.replace(/[:.]/g, '-')}-${uniqueSuffix}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast('Backup completo criado e baixado.');
  } catch (error) {
    toast(error.message || 'Não foi possível criar o backup completo.');
  }
};

$('fullRestoreBtn').onclick = () => $('fullBackupFile').click();
$('fullBackupFile').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  let backup;
  try {
    backup = JSON.parse(await file.text());
    const validation = await window.QuestionsApi.validateBackup(backup);
    const summary = validation.summary;
    const confirmed = confirm(
      `Backup válido. Será restaurado:\n\n` +
      `- Questões: ${summary.questions}\n` +
      `- Progresso por questão: ${summary.progressEntries}\n` +
      `- Respostas no histórico: ${summary.responseHistory}\n` +
      `- Tentativas em arquivo: ${summary.storedAttempts}\n` +
      `- Sessão em andamento: ${summary.hasActiveSession ? 'sim' : 'não'}\n\n` +
      'A restauração substituirá os arquivos locais de questões, sequência de IDs, dados do usuário, histórico e o progresso persistido. Um backup de segurança será criado antes da alteração. Continuar?'
    );
    if (!confirmed) return;

    const previousProgress = P;
    const restoredProgress = backup.data.progress;
    await progressSaveQueue;
    const result = await window.QuestionsApi.restoreBackup({ backup, currentProgress: previousProgress });

    Q = backup.data.questions.map(question => normalizeQuestion(question));
    byId = Object.fromEntries(Q.map(question => [question.id, question]));
    bankQuestions = backup.data.questions;
    bankStatus = bankQuestions.length ? 'ready' : 'empty';
    P = restoredProgress;
    progressPersisted = true;
    progressSaveError = false;
    renderProgressSaveStatus();
    S = P.session && P.session.ids.every(id => byId[id]) ? P.session : null;
    questionMapVisible = false;
    currentView = 'simulator';
    render();
    toast(`Backup restaurado. Cópia de segurança: ${result.safetyBackup}`);
  } catch (error) {
    toast(error.message || 'Não foi possível validar ou restaurar o backup.');
  }
};

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
    const imported = JSON.parse(await f.text());
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
      throw new Error('O arquivo não contém um objeto de progresso.');
    }
    const d = validateProgressState({ ...imported, session: imported.session ?? null });
    if (!confirm('Importar substituirá o progresso atual. Continuar?')) return;
    await progressSaveQueue;
    const result = await window.QuestionsApi.importProgress({ ...d, session: null });
    P = result.progress;
    progressPersisted = true;
    progressSaveError = false;
    renderProgressSaveStatus();
    S = null;
    render();
    toast(`Progresso restaurado. Backup de segurança: ${result.safetyBackup}`);
  } catch (err) { toast(err.message || 'Arquivo de progresso inválido.'); }
};

$('bankImportFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await importQuestionsFromFile(file);
};

$('resetBtn').onclick = async () => {
  if (!confirm('Tem certeza que deseja apagar todo o seu progresso?\n\nEsta ação removerá:\n- histórico\n- estatísticas\n- Banco de Erros\n- questões respondidas')) return;
  const previousProgress = P;
  const previousSession = S;
  P = createEmptyProgress();
  S = null;
  if (await save()) {
    render();
    toast('Progresso apagado.');
  } else {
    P = previousProgress;
    S = previousSession;
    render();
  }
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

init();
