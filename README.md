# jeroensoeters.github.io

A minimalist, fast, zero-framework personal blog. Markdown in, static HTML out.
No trackers, no cookie banners, no client-side frameworks — the only JavaScript
on a page is a ~15-line dark-mode toggle. CSS and the Agent Bridge diagram are
inlined at build time, so a page makes no extra requests beyond its images.

## How it works

```
posts/            Markdown source (front matter + body). One file per post.
assets/img/       Source images (screenshots, diagrams, banner, OG card).
src/
  build.mjs       The generator (~250 lines). Only dependency: markdown-it.
  style.css       The entire design. Inlined into every page at build.
docs/             BUILD OUTPUT. This is what GitHub Pages serves. Committed.
```

Clean URLs: `posts/foo.md` → `docs/foo/index.html` → `https://…/foo/`.

## Build

```bash
npm install      # once
npm run build    # writes docs/
npm run serve    # build + serve docs/ locally at http://localhost:3000
```

## Writing a post

Create `posts/<slug>.md` with front matter:

```markdown
---
title: My post title
slug: my-post
date: 2026-07-10
description: One-sentence summary used for the listing + OG/Twitter cards.
image: /assets/img/my-og-card.png   # optional; falls back to the site default
---

Body in Markdown…
```

Two build-time shortcodes are available in post bodies:

- `{{screenshot: file.png | caption}}` — renders a captioned `<figure>`. If
  `assets/img/file.png` doesn't exist yet, a labelled placeholder is shown
  instead, so drafts stay publishable. Drop the image in and rebuild.
- `{{diagram: file.svg | caption}}` — inlines the SVG directly into the page.

## Deploy (GitHub Actions)

Pages source is **GitHub Actions** (`.github/workflows/deploy.yml`). On every push to
`main`, CI runs `npm ci && npm run build` and publishes `docs/` via
`actions/deploy-pages`. A `concurrency: pages` group cancels a superseded in-flight
run so rapid edits don't collide.

`docs/` is **generated in CI and git-ignored** — don't commit it. The loop is just:
edit Markdown → commit → push. (Run `npm run build` locally only to preview.)
