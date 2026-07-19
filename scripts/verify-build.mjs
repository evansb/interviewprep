import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const quizDir = path.join(root, 'src/data/quizzes');
const files = (await readdir(quizDir)).filter((file) => file.endsWith('.json')).sort();

await access(path.join(dist, 'index.html'));
await access(path.join(dist, '404.html'));
await access(path.join(dist, 'pagefind/pagefind.js'));

const homeHtml = await readFile(path.join(dist, 'index.html'), 'utf8');
const configuredBase = (process.env.BASE_PATH || '/').replace(/^([^/])/, '/$1').replace(/([^/])$/, '$1/');
if (configuredBase !== '/') {
  if (homeHtml.includes('href="/chapters/')) throw new Error('Homepage contains a chapter link that bypasses BASE_PATH.');
  if (homeHtml.includes(`${configuredBase}${configuredBase.slice(1)}`)) throw new Error('Homepage contains a duplicated BASE_PATH.');
  if (!homeHtml.includes(`href="${configuredBase}chapters/chapter-01-`)) throw new Error('Homepage start link is not BASE_PATH-aware.');
}

for (const file of files) {
  const quiz = JSON.parse(await readFile(path.join(quizDir, file), 'utf8'));
  const htmlPath = path.join(dist, 'chapters', file.replace('.json', ''), 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes('class="book-quiz not-content"')) throw new Error(`${file}: quiz UI is missing from built HTML.`);
  if (!html.includes(`Chapter ${quiz.chapter} practice quiz`)) throw new Error(`${file}: quiz title is missing.`);
  for (const question of quiz.questions) {
    if (!html.includes(`id="${question.sourceAnchor}"`)) {
      throw new Error(`${file}: source anchor #${question.sourceAnchor} is missing from built HTML.`);
    }
  }
}

process.stdout.write(`Verified ${files.length} built chapter pages, quizzes, source anchors, search assets, and 404 page.\n`);
