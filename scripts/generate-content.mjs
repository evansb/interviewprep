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

const STOP_WORDS = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its of on or that the their this to vs what when where which why will with you your'.split(' '),
);

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

function words(value) {
  return cleanInline(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_+]+/u)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
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

function firstUsefulSentence(body) {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\|.*$/gm, ' ')
    .replace(/^[-*>#]+\s*/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = plain.match(/[^.!?]+[.!?]+/g) || [plain];
  return trimAnswer(candidates.find((item) => cleanInline(item).length >= 45) || candidates[0] || '', 280);
}

function bestSectionAnchor(text, sections) {
  const query = new Set(words(text));
  let best = null;
  let bestScore = 0;
  for (const section of sections.filter((item) => item.numbered)) {
    const headingWords = words(section.title);
    const bodyWords = new Set(words(section.body.slice(0, 1000)));
    let score = headingWords.reduce((sum, word) => sum + (query.has(word) ? 6 : 0), 0);
    for (const word of query) if (bodyWords.has(word)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = section.anchor;
    }
  }
  return best || sections.find((item) => item.numbered)?.anchor || 'key-interview-questions';
}

function parseInterviewQuestions(section) {
  if (!section) return [];
  const output = [];
  const pattern = /^\d+\.\s+\*\*(.+?\?)\*\*\s*[—–-]\s*(.+)$/gm;
  for (const match of section.body.matchAll(pattern)) {
    output.push({ prompt: cleanInline(match[1]), answer: trimAnswer(match[2]) });
  }
  return output;
}

function parseTraps(section) {
  if (!section) return [];
  return [...section.body.matchAll(/^-\s+(.+)$/gm)]
    .map((match) => trimAnswer(match[1]))
    .filter((item) => item.length >= 35);
}

function chooseDistractors(correct, pool, seed) {
  const candidates = [...new Set(pool.filter((item) => item && item !== correct))];
  const selected = [];
  for (let offset = 0; offset < candidates.length && selected.length < 3; offset += 1) {
    const candidate = candidates[(seed * 7 + offset * 11) % candidates.length];
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  const fallbacks = [
    'It is purely an implementation detail with no observable effect on correctness or performance.',
    'It is guaranteed by the C++ standard in every build mode and on every supported platform.',
    'It applies only at compile time and cannot affect runtime behavior or generated machine code.',
  ];
  for (const fallback of fallbacks) if (selected.length < 3 && fallback !== correct) selected.push(fallback);
  return selected.slice(0, 3);
}

function buildQuestion({ id, prompt, correct, explanation, sourceAnchor, difficulty }, pool, index) {
  const correctIndex = index % 4;
  const options = chooseDistractors(correct, pool, index);
  options.splice(correctIndex, 0, correct);
  return { id, prompt, options, correctIndex, explanation, sourceAnchor, difficulty };
}

function makeQuiz(chapter, markdown) {
  const sections = splitSections(markdown);
  const numbered = sections.filter((item) => item.numbered);
  const interviewSection = sections.find((item) => item.title === 'Key Interview Questions');
  const trapSection = sections.find((item) => item.title === 'Common Traps');
  const interviews = parseInterviewQuestions(interviewSection);
  const traps = parseTraps(trapSection);
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  const target = Math.min(
    50,
    Math.max(20, 20 + Math.floor(Math.max(wordCount - 5000, 0) / 1000) + Math.max(numbered.length - 10, 0)),
  );

  const sectionFacts = numbered
    .map((section) => ({ section, fact: firstUsefulSentence(section.body) }))
    .filter(({ fact }) => fact.length >= 35);
  const answerPool = [...interviews.map((item) => item.answer), ...traps, ...sectionFacts.map((item) => item.fact)];
  const questions = [];

  for (const item of interviews) {
    const anchor = bestSectionAnchor(`${item.prompt} ${item.answer}`, sections);
    questions.push(
      buildQuestion(
        {
          id: `${chapter.number}-interview-${questions.length + 1}`,
          prompt: item.prompt,
          correct: item.answer,
          explanation: item.answer,
          sourceAnchor: anchor,
          difficulty: questions.length % 3 === 0 ? 'application' : 'recall',
        },
        answerPool,
        questions.length,
      ),
    );
  }

  for (const trap of traps) {
    if (questions.length >= target) break;
    const topic = trimAnswer(trap.split(/[—–:]/)[0], 110);
    const anchor = bestSectionAnchor(trap, sections);
    questions.push(
      buildQuestion(
        {
          id: `${chapter.number}-trap-${questions.length + 1}`,
          prompt: `Which statement best addresses this common trap: “${topic}”?`,
          correct: trap,
          explanation: trap,
          sourceAnchor: anchor,
          difficulty: 'trap',
        },
        answerPool,
        questions.length,
      ),
    );
  }

  let sectionIndex = 0;
  while (questions.length < target && sectionFacts.length) {
    const { section, fact } = sectionFacts[sectionIndex % sectionFacts.length];
    const pass = Math.floor(sectionIndex / sectionFacts.length) + 1;
    const prompt = pass === 1
      ? `Which description best matches “${section.title.replace(/^\d+\.\d+\s+/, '')}”?`
      : `According to the chapter, what is an important consequence or property of “${section.title.replace(/^\d+\.\d+\s+/, '')}”?`;
    questions.push(
      buildQuestion(
        {
          id: `${chapter.number}-section-${questions.length + 1}`,
          prompt,
          correct: fact,
          explanation: fact,
          sourceAnchor: section.anchor,
          difficulty: pass === 1 ? 'recall' : 'application',
        },
        answerPool,
        questions.length,
      ),
    );
    sectionIndex += 1;
  }

  return {
    chapter: chapter.number,
    slug: chapter.slug,
    title: chapter.title,
    targetCount: target,
    questions: questions.slice(0, target),
  };
}

async function loadAuthoredBank(slug) {
  try {
    return JSON.parse(await readFile(path.join(bankDir, `${slug}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
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
  let authoredCount = 0;

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
    const quiz = bank ? buildAuthoredQuiz(chapter, bank, splitSections(source)) : makeQuiz(chapter, source);
    if (bank) authoredCount += 1;
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
    `Generated ${meta.length} chapters (${authoredCount} authored, ${meta.length - authoredCount} fallback) and ${totalQuestions} quiz questions.\n`,
  );
}

await main();
