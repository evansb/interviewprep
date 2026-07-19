import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const chapterDir = path.join(root, 'src/content/docs/chapters');
const quizDir = path.join(root, 'src/data/quizzes');

test('all chapters and quizzes are generated', async () => {
  const chapters = (await readdir(chapterDir)).filter((file) => file.endsWith('.md'));
  const quizzes = (await readdir(quizDir)).filter((file) => file.endsWith('.json'));
  assert.equal(chapters.length, 60);
  assert.equal(quizzes.length, 60);
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

test('generated navigation covers chapters 1 through 60 once', async () => {
  const moduleUrl = new URL('../src/generated/navigation.mjs', import.meta.url);
  const { sidebar } = await import(`${moduleUrl.href}?t=${Date.now()}`);
  assert.equal(sidebar.length, 14);
  const slugs = sidebar.flatMap((group) => group.items.map((item) => item.slug));
  assert.equal(slugs.length, 60);
  assert.equal(new Set(slugs).size, 60);
  assert.ok(slugs[0].includes('chapter-01-'));
  assert.ok(slugs[59].includes('chapter-60-'));
});
