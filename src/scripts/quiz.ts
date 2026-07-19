import type { BookProgress, ChapterProgress, ChapterQuiz, QuizQuestion } from '../lib/quiz';
import { readProgress, writeProgress } from '../lib/quiz';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] || character);
}

function chapterState(progress: BookProgress, slug: string): ChapterProgress {
  return progress.chapters[slug] || {
    currentIndex: 0,
    answers: {},
    bestScore: 0,
    completed: false,
  };
}

function scoreFor(quiz: ChapterQuiz, state: ChapterProgress): number {
  return quiz.questions.reduce((sum, question) => sum + (state.answers[question.id]?.correct ? 1 : 0), 0);
}

function initQuiz(root: HTMLElement) {
  if (root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';

  const payload = root.querySelector<HTMLScriptElement>('.quiz-payload');
  if (!payload?.textContent) return;
  const quiz = JSON.parse(payload.textContent) as ChapterQuiz;
  let progress = readProgress();
  let state = chapterState(progress, quiz.slug);
  state.currentIndex = Math.min(Math.max(state.currentIndex || 0, 0), quiz.questions.length - 1);
  progress.lastRead = quiz.slug;
  progress.chapters[quiz.slug] = state;
  const storageWorks = writeProgress(progress);

  const questionHost = root.querySelector<HTMLElement>('[data-quiz-question]')!;
  const feedback = root.querySelector<HTMLElement>('[data-quiz-feedback]')!;
  const position = root.querySelector<HTMLElement>('[data-quiz-position]')!;
  const difficulty = root.querySelector<HTMLElement>('[data-quiz-difficulty]')!;
  const meter = root.querySelector<HTMLElement>('[data-quiz-meter]')!;
  const score = root.querySelector<HTMLElement>('[data-quiz-score]')!;
  const previous = root.querySelector<HTMLButtonElement>('[data-quiz-previous]')!;
  const check = root.querySelector<HTMLButtonElement>('[data-quiz-check]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-quiz-next]')!;
  const storageNote = root.querySelector<HTMLElement>('[data-quiz-storage-note]')!;
  if (!storageWorks) storageNote.textContent = 'Browser storage is unavailable; this session will not be saved.';

  let selected: number | null = null;

  function save() {
    state.currentIndex = Math.min(state.currentIndex, quiz.questions.length - 1);
    progress.chapters[quiz.slug] = state;
    progress.lastRead = quiz.slug;
    if (!writeProgress(progress)) storageNote.textContent = 'Browser storage is unavailable; this session will not be saved.';
  }

  function showSummary() {
    const currentScore = scoreFor(quiz, state);
    const percent = Math.round((currentScore / quiz.questions.length) * 100);
    state.bestScore = Math.max(state.bestScore, percent);
    state.completed = state.completed || percent >= 80;
    save();
    position.textContent = 'Quiz complete';
    difficulty.textContent = state.completed ? 'Chapter complete' : 'Keep practicing';
    meter.style.width = '100%';
    score.textContent = String(currentScore);
    feedback.hidden = true;
    previous.hidden = true;
    check.hidden = true;
    next.hidden = true;

    const incorrect = quiz.questions.filter((question) => !state.answers[question.id]?.correct).length;
    questionHost.innerHTML = `
      <div class="quiz-summary" tabindex="-1">
        <p class="quiz-summary__mark">${percent}%</p>
        <h3>${percent >= 80 ? 'Chapter mastered' : 'A solid first pass'}</h3>
        <p>You answered ${currentScore} of ${quiz.questions.length} correctly. Your best score is ${state.bestScore}%.</p>
        <div class="quiz-summary__actions">
          ${incorrect ? '<button type="button" class="quiz-button quiz-button--primary" data-retry-incorrect>Retry incorrect questions</button>' : ''}
          <button type="button" class="quiz-button quiz-button--quiet" data-restart-quiz>Restart quiz</button>
        </div>
      </div>`;
    questionHost.querySelector<HTMLElement>('.quiz-summary')?.focus();
    questionHost.querySelector<HTMLButtonElement>('[data-retry-incorrect]')?.addEventListener('click', () => {
      const firstIncorrect = quiz.questions.findIndex((question) => !state.answers[question.id]?.correct);
      for (const question of quiz.questions) if (!state.answers[question.id]?.correct) delete state.answers[question.id];
      state.currentIndex = Math.max(firstIncorrect, 0);
      save();
      render();
    });
    questionHost.querySelector<HTMLButtonElement>('[data-restart-quiz]')?.addEventListener('click', () => {
      state.answers = {};
      state.currentIndex = 0;
      save();
      render();
    });
  }

  function renderFeedback(question: QuizQuestion, selectedIndex: number) {
    const correct = selectedIndex === question.correctIndex;
    feedback.className = `quiz-feedback ${correct ? 'is-correct' : 'is-incorrect'}`;
    feedback.innerHTML = `
      <strong>${correct ? 'Correct.' : 'Not quite.'}</strong>
      <p>${escapeHtml(question.explanation)}</p>
      <a href="#${escapeHtml(question.sourceAnchor)}">Review the relevant section <span aria-hidden="true">→</span></a>`;
    feedback.hidden = false;
  }

  function render() {
    const question = quiz.questions[state.currentIndex];
    if (!question) return;
    const saved = state.answers[question.id];
    selected = saved?.selected ?? null;
    const isAnswered = Boolean(saved);
    const currentScore = scoreFor(quiz, state);

    position.textContent = `Question ${state.currentIndex + 1} of ${quiz.questions.length}`;
    difficulty.textContent = question.difficulty;
    meter.style.width = `${((state.currentIndex + 1) / quiz.questions.length) * 100}%`;
    score.textContent = String(currentScore);
    previous.hidden = false;
    previous.disabled = state.currentIndex === 0;
    check.hidden = isAnswered;
    check.disabled = selected === null;
    next.hidden = !isAnswered;
    next.textContent = state.currentIndex === quiz.questions.length - 1 ? 'View results' : 'Next question';
    feedback.hidden = !isAnswered;

    const options = question.options.map((option, index) => {
      const checked = selected === index ? 'checked' : '';
      const disabled = isAnswered ? 'disabled' : '';
      const resultClass = isAnswered
        ? index === question.correctIndex
          ? ' is-answer-correct'
          : selected === index
            ? ' is-answer-incorrect'
            : ''
        : '';
      return `<label class="quiz-option${resultClass}">
        <input type="radio" name="question-${question.id}" value="${index}" ${checked} ${disabled}>
        <span class="quiz-option__letter" aria-hidden="true">${String.fromCharCode(65 + index)}</span>
        <span>${escapeHtml(option)}</span>
      </label>`;
    }).join('');
    questionHost.innerHTML = `<fieldset class="quiz-question">
      <legend>${escapeHtml(question.prompt)}</legend>
      <div class="quiz-options">${options}</div>
    </fieldset>`;

    if (isAnswered && selected !== null) renderFeedback(question, selected);
    questionHost.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        selected = Number(radio.value);
        check.disabled = false;
      });
    });
  }

  previous.addEventListener('click', () => {
    state.currentIndex = Math.max(0, state.currentIndex - 1);
    save();
    render();
  });
  check.addEventListener('click', () => {
    const question = quiz.questions[state.currentIndex];
    if (!question || selected === null) return;
    state.answers[question.id] = { selected, correct: selected === question.correctIndex };
    save();
    render();
    feedback.focus({ preventScroll: true });
  });
  next.addEventListener('click', () => {
    if (state.currentIndex === quiz.questions.length - 1) {
      showSummary();
      return;
    }
    state.currentIndex += 1;
    save();
    render();
    root.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });

  render();
}

document.querySelectorAll<HTMLElement>('.book-quiz').forEach(initQuiz);
document.addEventListener('astro:page-load', () => document.querySelectorAll<HTMLElement>('.book-quiz').forEach(initQuiz));
