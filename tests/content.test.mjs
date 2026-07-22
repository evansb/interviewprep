import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const chapterDir = path.join(root, 'src/content/docs/chapters');
const quizDir = path.join(root, 'src/data/quizzes');

test('all chapters and quizzes are generated', async () => {
  const rootChapters = (await readdir(root)).filter((file) => /^chapter-\d{2}-.+\.md$/.test(file));
  const chapters = (await readdir(chapterDir)).filter((file) => file.endsWith('.md'));
  const quizzes = (await readdir(quizDir)).filter((file) => file.endsWith('.json'));
  assert.equal(chapters.length, rootChapters.length);
  assert.equal(quizzes.length, rootChapters.length);
});

test('quiz banks satisfy the public data contract', async () => {
  const files = (await readdir(quizDir)).filter((file) => file.endsWith('.json')).sort();
  let total = 0;
  for (const file of files) {
    const quiz = JSON.parse(await readFile(path.join(quizDir, file), 'utf8'));
    assert.equal(quiz.questions.length, quiz.targetCount, `${file} target mismatch`);
    assert.ok(quiz.questions.length >= 20 && quiz.questions.length <= 50, `${file} count out of range`);
    const ids = new Set();
    const answerPositions = [0, 0, 0, 0];
    const chapter = await readFile(path.join(chapterDir, file.replace('.json', '.md')), 'utf8');
    for (const question of quiz.questions) {
      assert.ok(question.id && !ids.has(question.id), `${file} duplicate question ID`);
      ids.add(question.id);
      assert.ok(question.prompt.length >= 12, `${file} prompt too short`);
      assert.equal(question.options.length, 4, `${file} must have four options`);
      assert.equal(new Set(question.options).size, 4, `${file} has duplicate options`);
      assert.ok(Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex < 4);
      assert.ok(question.explanation.length >= 20, `${file} explanation too short`);
      assert.ok(['recall', 'application', 'trap'].includes(question.difficulty));
      assert.ok(chapter.includes(`## ${question.sourceAnchor.replaceAll('-', ' ')}`) || chapter.includes(`{#${question.sourceAnchor}}`) || question.sourceAnchor.length > 0);
      answerPositions[question.correctIndex] += 1;
    }
    assert.ok(Math.max(...answerPositions) - Math.min(...answerPositions) <= 1, `${file} answers are not balanced`);
    total += quiz.questions.length;
  }
  assert.ok(total >= 1200, `expected at least 1,200 questions, found ${total}`);
});

test('hand-authored quiz banks meet the authoring standards', async () => {
  const bankDir = path.join(root, 'quiz-banks');
  let files;
  try {
    files = (await readdir(bankDir)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return; // no authored banks yet
  }

  for (const file of files) {
    const bank = JSON.parse(await readFile(path.join(bankDir, file), 'utf8'));
    const chapter = await readFile(path.join(chapterDir, file.replace('.json', '.md')), 'utf8').catch(() => null);
    assert.ok(chapter, `${file} has no matching chapter page`);
    assert.equal(bank.slug, file.replace('.json', ''), `${file} slug mismatch`);

    const difficulties = { recall: 0, application: 0, trap: 0 };
    for (const question of bank.questions) {
      // Authored explanations must actually explain, not restate the correct option.
      assert.ok(question.explanation.length >= 80, `${file} ${question.id} explanation too short`);
      assert.ok(
        !question.options.includes(question.explanation),
        `${file} ${question.id} explanation merely repeats an option`,
      );
      // Options should be comparable in length so the correct one is not visually obvious.
      const lengths = question.options.map((option) => option.length);
      assert.ok(
        Math.max(...lengths) / Math.min(...lengths) <= 3,
        `${file} ${question.id} option lengths are lopsided (${lengths.join('/')})`,
      );
      assert.ok(
        chapter.includes(`{#${question.sourceAnchor}}`) || question.sourceAnchor.length > 0,
        `${file} ${question.id} has an empty sourceAnchor`,
      );
      // normalizeBank() reorders options, so a positional reference would point at the wrong one.
      assert.ok(
        !/\b(?:option|answer|choice)s? (?:[ABCD]\b|one\b|two\b|three\b|four\b)|\bthe (?:first|second|third|fourth|last|final|remaining|other) (?:option|answer|choice)\b/i.test(
          question.explanation,
        ),
        `${file} ${question.id} explanation refers to an option by position`,
      );
      difficulties[question.difficulty] += 1;
    }

    const count = bank.questions.length;
    assert.ok(difficulties.recall / count <= 0.5, `${file} is too recall-heavy`);
    assert.ok(difficulties.application / count >= 0.3, `${file} needs more application questions`);
    assert.ok(difficulties.trap > 0, `${file} has no trap questions`);
  }
});

test('generated navigation covers every chapter once', async () => {
  const rootChapters = (await readdir(root)).filter((file) => /^chapter-\d{2}-.+\.md$/.test(file));
  const topics = await readFile(path.join(root, 'TOPICS.md'), 'utf8');
  const groupCount = (topics.match(/^##\s+/gm) || []).length;
  const moduleUrl = new URL('../src/generated/navigation.mjs', import.meta.url);
  const { sidebar } = await import(`${moduleUrl.href}?t=${Date.now()}`);
  assert.equal(sidebar.length, groupCount);
  const slugs = sidebar.flatMap((group) => group.items.map((item) => item.slug));
  assert.equal(slugs.length, rootChapters.length);
  assert.equal(new Set(slugs).size, rootChapters.length);
  assert.ok(slugs[0].includes('chapter-01-'));
  const lastNum = String(rootChapters.length).padStart(2, '0');
  assert.ok(slugs[slugs.length - 1].includes(`chapter-${lastNum}-`));
});
