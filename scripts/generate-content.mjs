import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const chaptersDir = path.join(root, 'src/content/docs/chapters');
const quizzesDir = path.join(root, 'src/data/quizzes');
const generatedDir = path.join(root, 'src/generated');
const bankDir = path.join(root, 'quiz-banks');

const DIFFICULTIES = ['recall', 'application', 'trap'];
const MIN_EXPLANATION = 80;

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function cleanInline(value) {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimAnswer(value, max = 320) {
  const cleaned = cleanInline(value).replace(/^[-—:]\s*/, '');
  if (cleaned.length <= max) return cleaned;
  const sentence = cleaned.slice(0, max).replace(/\s+\S*$/, '');
  return `${sentence}…`;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function splitSections(markdown) {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const title = cleanInline(match[1]);
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return {
      title,
      anchor: slugify(match[1]),
      body: markdown.slice(start, end).trim(),
      numbered: /^\d+\.\d+\s/.test(title),
    };
  });
}

// Every chapter must ship a hand-authored bank; there is no generated fallback.
async function loadAuthoredBank(slug) {
  try {
    return JSON.parse(await readFile(path.join(bankDir, `${slug}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing authored quiz bank quiz-banks/${slug}.json.`);
    throw new Error(`Could not parse quiz-banks/${slug}.json: ${error.message}`);
  }
}

function validateBank(bank, chapter, sections) {
  const where = `quiz-banks/${chapter.slug}.json`;
  const fail = (message, id) => {
    throw new Error(`${where}${id ? ` [${id}]` : ''}: ${message}`);
  };

  if (bank.slug !== chapter.slug) fail(`slug is "${bank.slug}", expected "${chapter.slug}"`);
  if (!Array.isArray(bank.questions)) fail('questions must be an array');
  const count = bank.questions.length;
  if (count < 20 || count > 50) fail(`has ${count} questions, expected between 20 and 50`);

  const anchors = new Set(sections.map((section) => section.anchor));
  const ids = new Set();
  for (const question of bank.questions) {
    const id = question.id;
    if (!id || typeof id !== 'string') fail('question is missing a string id');
    if (ids.has(id)) fail('duplicate question id', id);
    ids.add(id);
    if (!question.prompt || question.prompt.length < 12) fail('prompt is missing or too short', id);
    if (!Array.isArray(question.options) || question.options.length !== 4) fail('must have exactly 4 options', id);
    if (new Set(question.options).size !== 4) fail('options must be distinct', id);
    if (question.options.some((option) => !option || typeof option !== 'string')) fail('options must be non-empty strings', id);
    if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex > 3) {
      fail(`correctIndex must be an integer 0-3, got ${question.correctIndex}`, id);
    }
    if (!question.explanation || question.explanation.length < MIN_EXPLANATION) {
      fail(`explanation must be at least ${MIN_EXPLANATION} characters, got ${question.explanation?.length ?? 0}`, id);
    }
    if (!DIFFICULTIES.includes(question.difficulty)) {
      fail(`difficulty must be one of ${DIFFICULTIES.join(', ')}, got "${question.difficulty}"`, id);
    }
    if (!anchors.has(question.sourceAnchor)) {
      fail(`sourceAnchor "${question.sourceAnchor}" does not match any heading in ${chapter.slug}.md`, id);
    }
  }
  return bank;
}

// Authors write correctIndex naturally; rotate the correct option into slot i % 4
// so answer positions stay balanced across the bank without authors tracking it.
function normalizeBank(bank) {
  return bank.questions.map((question, index) => {
    const target = index % 4;
    const options = [...question.options];
    const correct = options[question.correctIndex];
    options[question.correctIndex] = options[target];
    options[target] = correct;
    return { ...question, options, correctIndex: target };
  });
}

function buildAuthoredQuiz(chapter, bank, sections) {
  validateBank(bank, chapter, sections);
  const questions = normalizeBank(bank);
  return {
    chapter: chapter.number,
    slug: chapter.slug,
    title: chapter.title,
    targetCount: questions.length,
    questions,
  };
}

function parseInventory(markdown) {
  const groups = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const groupMatch = line.match(/^##\s+(.+)$/);
    if (groupMatch) {
      current = { label: cleanInline(groupMatch[1]), chapters: [] };
      groups.push(current);
      continue;
    }
    const chapterMatch = line.match(/^-\s+\*\*Chapter\s+(\d+):\s+(.+?)\*\*$/);
    if (chapterMatch && current) {
      current.chapters.push({ number: Number(chapterMatch[1]), inventoryTitle: cleanInline(chapterMatch[2]) });
    }
  }
  return groups;
}

async function main() {
  const topicMarkdown = await readFile(path.join(root, 'TOPICS.md'), 'utf8');
  const groups = parseInventory(topicMarkdown);
  const files = (await readdir(root)).filter((name) => /^chapter-\d{2}-.+\.md$/.test(name)).sort();

  if (files.length !== 74) throw new Error(`Expected 74 chapters, found ${files.length}.`);

  await rm(chaptersDir, { recursive: true, force: true });
  await rm(quizzesDir, { recursive: true, force: true });
  await mkdir(chaptersDir, { recursive: true });
  await mkdir(quizzesDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });

  const chapterByNumber = new Map();
  const meta = [];

  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    const titleMatch = source.match(/^#\s+Chapter\s+(\d+)\s+[—–-]\s+(.+)$/m);
    if (!titleMatch) throw new Error(`Missing chapter title in ${file}.`);
    const number = Number(titleMatch[1]);
    const title = cleanInline(titleMatch[2]);
    const slug = file.replace(/\.md$/, '');
    const group = groups.find((item) => item.chapters.some((chapter) => chapter.number === number));
    if (!group) throw new Error(`Chapter ${number} is not present in TOPICS.md.`);
    const intro = source
      .slice(titleMatch.index + titleMatch[0].length)
      .replace(/^\s*\*([^\n]+)\*/m, '$1')
      .split('\n')
      .map((line) => cleanInline(line))
      .find((line) => line.length > 45) || `${title}: interview-focused revision notes.`;
    const description = trimAnswer(intro, 180);
    const chapter = { number, title, slug, group: group.label, description };
    chapterByNumber.set(number, chapter);

    const body = source
      .replace(/^#\s+Chapter\s+\d+\s+[—–-]\s+.+\n+/, '')
      .replace(/^---\s*\n+/, '');
    const frontmatter = [
      '---',
      `title: ${yamlString(`Chapter ${number} — ${title}`)}`,
      `description: ${yamlString(description)}`,
      `sidebar:`,
      `  order: ${number}`,
      `  label: ${yamlString(`${number}. ${title}`)}`,
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(chaptersDir, file), `${frontmatter}${body}`, 'utf8');

    const bank = await loadAuthoredBank(slug);
    const quiz = buildAuthoredQuiz(chapter, bank, splitSections(source));
    await writeFile(path.join(quizzesDir, `${slug}.json`), `${JSON.stringify(quiz, null, 2)}\n`, 'utf8');
    meta.push({ ...chapter, questionCount: quiz.questions.length, wordCount: source.split(/\s+/).filter(Boolean).length });
  }

  const sidebar = groups.map((group) => ({
    label: group.label,
    collapsed: true,
    items: group.chapters.map(({ number }) => {
      const chapter = chapterByNumber.get(number);
      if (!chapter) throw new Error(`Missing chapter ${number}.`);
      return { label: `${number}. ${chapter.title}`, slug: `chapters/${chapter.slug}` };
    }),
  }));

  await writeFile(
    path.join(generatedDir, 'navigation.mjs'),
    `// Generated by scripts/generate-content.mjs\nexport const sidebar = ${JSON.stringify(sidebar, null, 2)};\n`,
    'utf8',
  );
  await writeFile(path.join(generatedDir, 'book-meta.json'), `${JSON.stringify({ groups, chapters: meta }, null, 2)}\n`, 'utf8');

  const totalQuestions = meta.reduce((sum, chapter) => sum + chapter.questionCount, 0);
  process.stdout.write(
    `Generated ${meta.length} chapters and ${totalQuestions} authored quiz questions.\n`,
  );
}

await main();
