# The Low-Latency C++ Interview Bible

A static, searchable, 60-chapter web book built with Astro and Starlight. Each chapter includes an interactive multiple-choice practice quiz with immediate explanations and browser-local progress.

## Local development

```sh
npm install
npm run dev
```

The root `chapter-*.md` files and `TOPICS.md` are canonical. Before development and production builds, `scripts/generate-content.mjs` creates Starlight-ready chapter pages, navigation metadata, and quiz banks. Generated content is intentionally ignored by Git.

Useful commands:

```sh
npm run content  # regenerate chapters, navigation, and quizzes
npm test         # validate all content and quiz banks
npm run check    # run Astro and TypeScript checks
npm run build    # create the static site in dist/
npm run preview  # preview the production build
```

## Quiz authoring model

Every generated question has a stable ID, four options, one correct index, an explanation, a source section anchor, and a difficulty. Existing “Key Interview Questions” form the primary bank; “Common Traps” and numbered sections expand coverage according to chapter length and complexity. The test suite enforces 20–50 questions per chapter, uniqueness, valid answers, explanations, and balanced correct-option positions.

Reader state uses the versioned `llcpp-book:v1:progress` local-storage key. It contains only last-read position, quiz answers, completion, and best scores; no data leaves the browser.

## GitHub Pages

The included workflow tests and deploys pushes to `main`. In the repository settings, choose **GitHub Actions** as the Pages source.

For a project site, configure repository variables used during the build:

```text
SITE_URL=https://YOUR-USER.github.io
BASE_PATH=/YOUR-REPOSITORY/
```

For a root site or custom domain, use `/` for `BASE_PATH`. The built `dist/` directory can also be hosted by any static file host.

If these variables are omitted in GitHub Actions, the Astro configuration infers both values from `GITHUB_REPOSITORY` and handles root `username.github.io` repositories separately from project repositories.
