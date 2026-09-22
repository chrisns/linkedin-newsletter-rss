/**
 * The HTML surfaces, in the CNS design system.
 *
 * The CSS is generated from @chrisns/design by scripts/build-css.mjs and
 * inlined, so a page costs one request and nothing blocks rendering except the
 * font link. Class names come from the govbuy UI kit; see styles.local.css for
 * the one component the design system does not have.
 */
import { CSS, FAVICON, FONT_HREF } from "./styles.generated.js";

/** Chris's own newsletter, used as the worked example. */
export const EXAMPLE = {
  slug: "cloudy-with-chance-of-freefall-7439561267528458241",
  title: "Cloudy with a chance of freefall",
  author: "Chris Nesbitt-Smith",
};

const REPO = "https://github.com/chrisns/linkedin-newsletter-rss";

/** The design system's own monogram, inlined at build time. */
export { FAVICON };

const escape = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function shell({ title, description, body, script = "" }) {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="color-scheme" content="light">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_HREF}">
<style>${CSS}</style>
</head>
<body>
<div class="page">
<header class="masthead">
  <div class="masthead-row">
    <a class="brand" href="/">
      <span class="brand-cns">cns</span><span class="brand-dot"></span><span class="brand-me">me</span>
      <span class="brand-blog">linkedinrss</span>
    </a>
    <p class="masthead-meta">LinkedIn newsletters, read in <em>your</em> reader</p>
  </div>
  <nav class="masthead-nav rule">
    <span class="nav-left"><a href="/">Make a feed</a></span>
    <span class="nav-right"><a href="${REPO}">Source</a><a href="https://cns.me">cns.me</a></span>
  </nav>
</header>
${body}
<footer class="colophon rule">
  <div class="colophon-grid">
    <div>
      <p class="cl-h">About</p>
      <p class="cl-note">LinkedIn publishes newsletters but no feeds. This reads the
      public page and gives you RSS. No account, no cookies, nothing about you.
      It does count how often each newsletter is fetched, and publishes the busiest.</p>
    </div>
    <div>
      <p class="cl-h">Elsewhere</p>
      <ul class="cl-list">
        <li><a href="${REPO}">Source on GitHub</a></li>
        <li><a href="https://cns.me">cns.me</a></li>
        <li><a href="https://blog.cns.me">blog.cns.me</a></li>
      </ul>
    </div>
    <div>
      <p class="cl-h">Colophon</p>
      <ul class="cl-list">
        <li>Cloudflare Workers</li>
        <li>Fraunces, Hanken Grotesk</li>
        <li>MIT licensed</li>
      </ul>
    </div>
  </div>
  <p class="cl-fine">Not affiliated with LinkedIn. Article text belongs to its authors.
  Built by Chris Nesbitt-Smith. &#10086;</p>
</footer>
</div>
${script}
</body>
</html>`;
}

/**
 * Render the most-followed panel. Falls back to the worked example when there
 * is no data yet, so the section is never an empty box.
 */
function popularSection(popular) {
  if (!popular || popular.length === 0) return "";
  const max = Math.max(...popular.map((p) => p.hits));
  const rows = popular
    .map(
      (p) => `      <div class="bar-row">
        <a class="bar-label" href="/${encodeURIComponent(p.slug)}">${escape(p.title || p.slug)}</a>
        <div class="bar-track"><div class="bar-fill bf-pink" style="width:${Math.max(
          2,
          Math.round((p.hits / max) * 100)
        )}%"></div></div>
        <span class="bar-val numeral">${p.hits.toLocaleString("en-GB")}</span>
      </div>`
    )
    .join("\n");

  return `<section class="section-header">
  <div class="sh-row">
    <span class="eyebrow on-paper">&#167;03 &mdash; Most followed</span>
  </div>
  <h2 class="sh-title">What other people <em>read</em></h2>
  <p class="section-lede">The newsletters this service fetches most often, over the last seven days.</p>
  <div class="dash">
    <div class="dash-head">
      <h3>Feeds served</h3>
      <p class="dash-note">Counted per request, not per reader, and nothing is recorded
      about who asked. A newsletter polled often by one person can outrank a quiet
      one read by many.</p>
    </div>
    <div class="bars">
${rows}
    </div>
  </div>
</section>`;
}

export function homepageHtml(popular) {
  const exampleFeed = `/${EXAMPLE.slug}`;

  const body = `<section class="hero">
  <div class="hero-body">
    <span class="eyebrow on-paper">&#167;01 &mdash; LinkedIn newsletter to RSS</span>
    <h1 class="hero-headline">Read LinkedIn <em>without</em> LinkedIn</h1>
    <p class="hero-lede">Paste a newsletter URL, an article URL or a slug. You get an
    RSS feed with the full text of every issue, images and all. No account, no tracking
    parameters, no algorithm deciding what you see.</p>
    <div class="install" id="strip">
      <form id="form" autocomplete="off">
        <input class="field" type="text" id="url" name="url" spellcheck="false"
          placeholder="https://www.linkedin.com/newsletters/&hellip;"
          aria-label="LinkedIn newsletter or article URL" required>
        <button class="copy-btn" type="submit">Get feed</button>
      </form>
    </div>
    <p class="hero-fine">Accepts a newsletter URL, an article URL or a bare slug.</p>
  </div>
  <div class="hero-stats">
    <div class="stat">
      <span class="stat-num numeral">5</span>
      <span class="stat-cap">Issues per page</span>
    </div>
    <div class="stat">
      <span class="stat-num numeral">0</span>
      <span class="stat-cap">Accounts needed</span>
    </div>
  </div>
</section>

<section class="section-header">
  <div class="sh-row">
    <span class="eyebrow on-paper">&#167;02 &mdash; A worked example</span>
  </div>
  <h2 class="sh-title">Here is one <em>working</em></h2>
  <p class="section-lede">My own newsletter, <em>${escape(EXAMPLE.title)}</em>, served as
  RSS by this service. Open it, or paste it into your reader.</p>
  <div class="install">
    <a class="feed-url" href="${exampleFeed}">https://linkedinrss.cns.me${exampleFeed}</a>
    <button class="copy-btn" type="button" id="copy"
      data-copy="https://linkedinrss.cns.me${exampleFeed}">Copy</button>
  </div>
  <p class="hero-fine">Source: <a href="https://www.linkedin.com/newsletters/${EXAMPLE.slug}/">${escape(
    EXAMPLE.title
  )}</a> by ${escape(EXAMPLE.author)}.</p>

  <div class="layer-grid">
    <div class="layer">
      <span class="layer-no numeral">01</span>
      <h3>It reads the public page</h3>
      <p>The same page you would see logged out. <b>Nothing private</b> is touched.</p>
    </div>
    <div class="layer">
      <span class="layer-no numeral">02</span>
      <h3>It strips the tracking</h3>
      <p>Redirect wrappers are unwrapped and <b>every trk parameter</b> is removed.</p>
    </div>
    <div class="layer">
      <span class="layer-no numeral">03</span>
      <h3>It keeps the pictures</h3>
      <p>Images are proxied, so they load in a reader that <b>blocks LinkedIn</b>.</p>
    </div>
  </div>
</section>

${popularSection(popular)}`;

  const script = `<script>
(function () {
  var form = document.getElementById("form");
  var strip = document.getElementById("strip");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var value = document.getElementById("url").value.trim();
    var match;
    if ((match = value.match(/linkedin\\.com\\/newsletters\\/([^/?]+)/))) {
      window.location.href = "/" + encodeURIComponent(match[1]);
    } else if ((match = value.match(/linkedin\\.com\\/pulse\\/([^/?]+)/))) {
      window.location.href = "/pulse/" + encodeURIComponent(match[1]);
    } else {
      var slug = value.replace(/^\\//, "");
      if (slug) {
        window.location.href = "/" + encodeURIComponent(slug);
      } else {
        strip.classList.add("is-error");
      }
    }
  });
  var copy = document.getElementById("copy");
  if (copy && navigator.clipboard) {
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(copy.dataset.copy).then(function () {
        copy.textContent = "Copied";
        copy.classList.add("done");
        setTimeout(function () {
          copy.textContent = "Copy";
          copy.classList.remove("done");
        }, 2000);
      });
    });
  }
})();
</script>`;

  return shell({
    title: "LinkedIn Newsletter to RSS",
    description:
      "Turn any public LinkedIn newsletter into an RSS feed. Full text, images, no tracking.",
    body,
    script,
  });
}

/**
 * The error pages, written out in full here.
 *
 * Keyed rather than parameterised so the copy cannot come from a thrown error:
 * a message can name an upstream URL or a parser internal, and the reader has
 * no use for either. `plain` is a separate hand-written line for the meta
 * description, because stripping tags out of `message` with a regex is not a
 * reliable way to get text.
 */
const ERRORS = {
  404: {
    heading: "No newsletter <em>there</em>",
    message:
      "LinkedIn has no public newsletter or article at that address. Check the URL, then try again.",
    plain:
      "LinkedIn has no public newsletter or article at that address.",
  },
  502: {
    heading: "That did not <em>work</em>",
    message:
      "LinkedIn did not give us a page we could read. Either that newsletter does not exist, or LinkedIn is having trouble. Check the address, then try again in a minute.",
    plain:
      "LinkedIn did not give us a page we could read. Try again in a minute.",
  },
};

export function errorHtml(status) {
  const { heading, message, plain } = ERRORS[status] || ERRORS[502];
  const body = `<section class="hero">
  <div class="hero-body">
    <span class="eyebrow on-paper">&#167; Error &mdash; ${status}</span>
    <h1 class="hero-headline">${heading}</h1>
    <p class="hero-lede">${message}</p>
    <p class="hero-fine"><a href="/">Start again from the front page.</a></p>
  </div>
</section>`;
  return shell({
    title: `${status} — LinkedIn Newsletter to RSS`,
    description: plain,
    body,
  });
}
