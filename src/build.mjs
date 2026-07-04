// ---------------------------------------------------------------------------
// Tiny static-site generator. Zero client-side frameworks.
//   posts/*.md  ->  docs/<slug>/index.html   (clean URLs)
//   + docs/index.html, sitemap.xml, feed.xml, robots.txt, .nojekyll
// The only runtime dependency is markdown-it. The Agent Bridge diagram and all
// CSS are inlined at build time, so a published page makes zero extra requests
// (aside from the images) and ships ~15 lines of JS for the theme toggle.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const POSTS_DIR = join(ROOT, "posts");
const ASSETS_DIR = join(ROOT, "assets");
const OUT = join(ROOT, "docs");

// --- Site configuration -----------------------------------------------------
const SITE = {
  title: "Jeroen Soeters",
  tagline: "Notes on infrastructure, AI agents, and the tools we build.",
  author: "Jeroen Soeters",
  url: "https://jeroensoeters.github.io", // no trailing slash
  lang: "en",
  ogImage: "/assets/img/dark-factory-og.jpg", // 1200x630 social card
};

// --- Markdown ----------------------------------------------------------------
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// Give h2/h3 stable ids so sections are deep-linkable.
const slugify = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
md.core.ruler.push("heading_ids", (state) => {
  const t = state.tokens;
  for (let i = 0; i < t.length; i++) {
    if (t[i].type === "heading_open" && (t[i].tag === "h2" || t[i].tag === "h3")) {
      const inline = t[i + 1];
      if (inline && inline.type === "inline") t[i].attrSet("id", slugify(inline.content));
    }
  }
});

// --- Helpers -----------------------------------------------------------------
function parseFrontMatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { data, body: raw.slice(m[0].length) };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[mo - 1]} ${d}, ${y}`;
}

function readingTime(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

// Expand {{screenshot: file | caption}} and {{diagram: file | caption}} into
// figures. Returns { body, blocks } — shortcodes are swapped for placeholder
// tokens that we re-inject AFTER markdown rendering (so inlined SVG/HTML isn't
// escaped by markdown-it).
function extractShortcodes(body) {
  const blocks = [];
  const swap = (html) => {
    const token = `@@BLOCK_${blocks.length}@@`;
    blocks.push(html);
    return `\n\n${token}\n\n`;
  };

  body = body.replace(/\{\{\s*screenshot:\s*([^|}]+?)\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_, file, caption = "") => {
    file = file.trim();
    const cap = caption ? `<figcaption>${esc(caption.trim())}</figcaption>` : "";
    if (existsSync(join(ASSETS_DIR, "img", file))) {
      return swap(
        `<figure><img src="/assets/img/${esc(file)}" alt="${esc(caption.trim() || file)}" loading="lazy" decoding="async">${cap}</figure>`
      );
    }
    // Graceful placeholder until the real screenshot is added to assets/img/.
    return swap(
      `<figure class="placeholder"><div class="box">screenshot pending — drop <code>assets/img/${esc(file)}</code> and rebuild</div>${cap}</figure>`
    );
  });

  body = body.replace(/\{\{\s*diagram:\s*([^|}]+?)\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_, file, caption = "") => {
    file = file.trim();
    const cap = caption ? `<figcaption>${esc(caption.trim())}</figcaption>` : "";
    const p = join(ASSETS_DIR, "img", file);
    const svg = existsSync(p) ? readFileSync(p, "utf8").replace(/<\?xml[^>]*\?>\s*/i, "") : "";
    return swap(`<figure class="diagram" role="img" aria-label="${esc(caption.trim())}">${svg}${cap}</figure>`);
  });

  return { body, blocks };
}

function reinjectBlocks(html, blocks) {
  return blocks.reduce(
    (acc, block, i) => acc.replace(new RegExp(`<p>@@BLOCK_${i}@@</p>|@@BLOCK_${i}@@`), () => block),
    html
  );
}

// --- Page shell --------------------------------------------------------------
const STYLE = readFileSync(join(__dirname, "style.css"), "utf8");

// Runs before first paint: apply saved/OS theme with no flash of wrong theme.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();`;
const THEME_TOGGLE = `document.getElementById('theme-toggle').addEventListener('click',function(){var d=document.documentElement,c=d.dataset.theme;var t=(c?c:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark'?'light':'dark';d.dataset.theme=t;try{localStorage.setItem('theme',t);}catch(e){}});`;

function header() {
  return `<header class="site-header"><div class="wrap"><div class="bar">
    <div>
      <p class="site-title"><a href="/">${esc(SITE.title)}</a></p>
      <p class="tagline">${esc(SITE.tagline)}</p>
    </div>
    <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">
      <span class="icon-light" aria-hidden="true">☾</span><span class="icon-dark" aria-hidden="true">☀</span>
    </button>
  </div></div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap bar">
    <span>© 2026 ${esc(SITE.author)}</span>
    <span><a href="/feed.xml">RSS</a> · built with a tiny script, no trackers</span>
  </div></footer>`;
}

function page({ title, description, canonical, ogImage, ogType = "website", bodyClass = "", content }) {
  const desc = esc(description || SITE.tagline);
  const img = SITE.url + (ogImage || SITE.ogImage);
  const fullTitle = title === SITE.title ? title : `${title} — ${SITE.title}`;
  return `<!doctype html>
<html lang="${SITE.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${desc}">
<meta name="author" content="${esc(SITE.author)}">
<link rel="canonical" href="${canonical}">
<link rel="alternate" type="application/rss+xml" title="${esc(SITE.title)}" href="/feed.xml">
<!-- Open Graph -->
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${esc(SITE.title)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='14'>◼</text></svg>">
<script>${THEME_INIT}</script>
<style>${STYLE}</style>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
${header()}
<main class="wrap">
${content}
</main>
${footer()}
<script>${THEME_TOGGLE}</script>
</body>
</html>`;
}

// --- Load posts --------------------------------------------------------------
function loadPosts() {
  return readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, body } = parseFrontMatter(readFileSync(join(POSTS_DIR, f), "utf8"));
      const slug = data.slug || f.replace(/\.md$/, "");
      const { body: cleaned, blocks } = extractShortcodes(body);
      const html = reinjectBlocks(md.render(cleaned), blocks);
      return {
        slug,
        title: data.title || slug,
        date: data.date,
        description: data.description || "",
        ogImage: data.image,
        banner: data.banner,
        minutes: readingTime(body.replace(/\{\{[^}]*\}\}/g, "")),
        html,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// --- Render ------------------------------------------------------------------
function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets", "img"), { recursive: true });

  const posts = loadPosts();

  // Individual post pages
  for (const p of posts) {
    const canonical = `${SITE.url}/${p.slug}/`;
    const hero = p.banner
      ? `<figure class="hero"><img src="${esc(p.banner)}" alt="${esc(p.title)}" fetchpriority="high" decoding="async"></figure>\n  `
      : "";
    const content = `<article>
  ${hero}<div class="post-header">
    <h1>${esc(p.title)}</h1>
    <p class="post-meta"><time datetime="${p.date}">${formatDate(p.date)}</time> · ${p.minutes} min read</p>
  </div>
  ${p.html}
</article>`;
    mkdirSync(join(OUT, p.slug), { recursive: true });
    writeFileSync(
      join(OUT, p.slug, "index.html"),
      page({ title: p.title, description: p.description, canonical, ogImage: p.ogImage, ogType: "article", content })
    );
  }

  // Home
  const list = posts
    .map(
      (p) => `  <li>
    <time datetime="${p.date}">${formatDate(p.date)}</time>
    <a href="/${p.slug}/">${esc(p.title)}</a>
    ${p.description ? `<p>${esc(p.description)}</p>` : ""}
  </li>`
    )
    .join("\n");
  writeFileSync(
    join(OUT, "index.html"),
    page({
      title: SITE.title,
      description: SITE.tagline,
      canonical: SITE.url + "/",
      content: `<ul class="post-list">\n${list}\n</ul>`,
    })
  );

  // Assets
  copyAssets();

  // sitemap / robots / rss / .nojekyll
  writeFeeds(posts);

  console.log(`Built ${posts.length} post(s) → ${OUT}`);
}

function copyAssets() {
  const imgDir = join(ASSETS_DIR, "img");
  if (existsSync(imgDir)) {
    for (const f of readdirSync(imgDir)) {
      copyFileSync(join(imgDir, f), join(OUT, "assets", "img", f));
    }
  }
}

function writeFeeds(posts) {
  writeFileSync(join(OUT, ".nojekyll"), "");
  writeFileSync(
    join(OUT, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`
  );

  const urls = [SITE.url + "/", ...posts.map((p) => `${SITE.url}/${p.slug}/`)];
  writeFileSync(
    join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
      `\n</urlset>\n`
  );

  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE.url}/${p.slug}/</link>
      <guid>${SITE.url}/${p.slug}/</guid>
      <pubDate>${new Date(p.date + "T09:00:00Z").toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`
    )
    .join("\n");
  writeFileSync(
    join(OUT, "feed.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
    <title>${esc(SITE.title)}</title>
    <link>${SITE.url}/</link>
    <description>${esc(SITE.tagline)}</description>
    <language>${SITE.lang}</language>
${items}
</channel></rss>\n`
  );
}

build();
