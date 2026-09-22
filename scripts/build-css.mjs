/**
 * Generate styles.generated.js from the CNS design system.
 *
 * The Worker inlines its CSS, so shipping the whole govbuy kit would send ~21KB
 * of rules for components this site does not have. This script keeps only the
 * rules whose selectors mention a class the pages actually use, which it reads
 * back out of index.js. Add a class to the markup and its rules follow; nothing
 * is hand-copied, so the design system stays canonical.
 *
 * Run: npm run build:css
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = join(ROOT, "node_modules", "@chrisns", "design");

/**
 * Fonts. The design system imports the union of every weight its three sites
 * use; this page needs far fewer, and an @import inside <style> blocks
 * rendering. A trimmed <link> goes in <head> instead.
 */
const FONTS = {
  Fraunces: { italics: [400, 700], romans: [700, 800, 900], axis: "9..144" },
  "Hanken Grotesk": { romans: [400, 500, 600, 700] },
  "JetBrains Mono": { romans: [400, 500] },
};
const ALLOWED_WEIGHTS = new Set([300, 400, 500, 600, 700, 800, 900]);

/**
 * Split a stylesheet into top-level rules, keeping at-rule blocks whole.
 */
function splitRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let inComment = false;
  for (let i = 0; i < css.length; i++) {
    if (inComment) {
      if (css[i] === "*" && css[i + 1] === "/") inComment = false;
      continue;
    }
    if (css[i] === "/" && css[i + 1] === "*") {
      inComment = true;
      continue;
    }
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        rules.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
  }
  return rules.filter(Boolean);
}

// Comments are stripped here, not just for tidiness: a comment containing a
// comma splits into a fragment with no class in it, which keepRule would then
// treat as a bare element selector and keep.
const selectorOf = (rule) =>
  rule
    .slice(0, rule.indexOf("{"))
    .replace(/\/\*[^]*?\*\//g, "")
    .trim();
const bodyOf = (rule) => rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));

/**
 * Keep a rule when any of its comma-separated selectors is wanted. A selector
 * with no class at all (`:root`, `*`, bare elements) is always kept: those are
 * the reset and the tokens.
 */
function keepRule(rule, usedClasses) {
  const selector = selectorOf(rule);
  if (selector.startsWith("@")) return true;
  return selector.split(",").some((part) => {
    const classes = part.match(/\.[A-Za-z0-9_-]+/g);
    if (!classes) return true;
    return classes.every((c) => usedClasses.has(c.slice(1)));
  });
}

/**
 * Remove `@import ...;` statements.
 *
 * Not a regex: the Google Fonts URL separates weights with semicolons, so
 * matching to the first `;` cuts the statement in half and leaves the rest of
 * the URL behind as stray CSS. Scan to the first `;` outside quotes and parens.
 */
function stripImports(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@import", i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    let j = at;
    let quote = null;
    let depth = 0;
    for (; j < css.length; j++) {
      const c = css[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

function filterCss(css, usedClasses) {
  // Statement at-rules end in `;`, not `}`, so the brace splitter cannot see
  // them: they ride along on the front of the next rule. Remove them first.
  // The font @import is replaced by a <link>; see fontHref().
  return splitRules(stripImports(css))
    .map((rule) => {
      const selector = selectorOf(rule);
      if (selector.startsWith("@media") || selector.startsWith("@supports")) {
        const inner = splitRules(bodyOf(rule)).filter((r) =>
          keepRule(r, usedClasses)
        );
        return inner.length ? `${selector}{${inner.join("")}}` : "";
      }
      if (selector.startsWith("@keyframes")) return rule; // pruned later
      return keepRule(rule, usedClasses) ? rule : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Drop keyframes nothing animates, and :root custom properties nothing reads.
 * Token resolution is transitive: --link is var(--pink-deep), so --pink-deep
 * must survive even when no rule names it directly.
 */
function prune(css) {
  // Comments first: a `/* ... */` between declarations otherwise gets carried
  // into the next one and hides its name.
  let out = css.replace(/\/\*[^]*?\*\//g, "");

  // Structurally, not by regex: a @keyframes block holds nested braces, so a
  // non-greedy match stops at the first `}` and leaves the rest behind as
  // syntactically broken CSS.
  const rules = splitRules(out);
  const animated = rules
    .filter((r) => !selectorOf(r).startsWith("@keyframes"))
    .join("\n");
  out = rules
    .filter((rule) => {
      const selector = selectorOf(rule);
      if (!selector.startsWith("@keyframes")) return true;
      const name = selector.slice("@keyframes".length).trim();
      return new RegExp(`animation(-name)?\\s*:[^;}]*\\b${name}\\b`).test(animated);
    })
    .join("\n");

  const rootMatch = out.match(/:root\s*\{([^]*?)\}/);
  if (rootMatch) {
    const declarations = rootMatch[1]
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return { name: d.slice(0, i).trim(), value: d.slice(i + 1).trim(), raw: d };
      })
      .filter((d) => d.name.startsWith("--"));

    const rest = out.replace(/:root\s*\{[^]*?\}/, "");
    const wanted = new Set(
      [...rest.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of declarations) {
        if (!wanted.has(d.name)) continue;
        for (const [, ref] of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (!wanted.has(ref)) {
            wanted.add(ref);
            grew = true;
          }
        }
      }
    }
    const kept = declarations.filter((d) => wanted.has(d.name));
    out = out.replace(/:root\s*\{[^]*?\}/, `:root{${kept.map((d) => d.raw).join(";")}}`);
  }

  return out;
}

function minify(css) {
  return css
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/\s*([{};:,>])\s*/g, "$1")
    .replace(/;\}/g, "}")
    .replace(/\s+/g, " ")
    .trim();
}

function fontHref() {
  const families = Object.entries(FONTS).map(([name, spec]) => {
    const family = name.replace(/ /g, "+");
    if (spec.italics) {
      const romans = spec.romans.map((w) => `0,${spec.axis},${w}`);
      const italics = spec.italics.map((w) => `1,${spec.axis},${w}`);
      return `family=${family}:ital,opsz,wght@${[...romans, ...italics].join(";")}`;
    }
    return `family=${family}:wght@${spec.romans.join(";")}`;
  });
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

// --- build ------------------------------------------------------------------

const SOURCES = ["pages.js", "index.js"];
const markup = SOURCES.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
const usedClasses = new Set();
for (const [, value] of markup.matchAll(/class="([^"]+)"/g)) {
  for (const name of value.split(/\s+/)) if (name) usedClasses.add(name);
}
// Toggled from the inline script rather than written in the markup.
for (const name of ["done", "is-error"]) usedClasses.add(name);

if (usedClasses.size < 5) {
  throw new Error(
    `Only ${usedClasses.size} classes found in ${SOURCES.join(", ")} — refusing to emit near-empty CSS`
  );
}

const tokens = readFileSync(join(DESIGN, "tokens.css"), "utf8");
const kit = readFileSync(join(DESIGN, "ui_kits", "govbuy", "govbuy.css"), "utf8");
const local = readFileSync(join(ROOT, "styles.local.css"), "utf8");

// The site-local layer must be expressed in tokens only. A raw colour here is
// exactly the drift the design system exists to prevent.
const rawColour = local
  .replace(/\/\*[^]*?\*\//g, "")
  .match(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/);
if (rawColour) {
  throw new Error(
    `styles.local.css uses a raw colour (${rawColour[0]}). Use a design token instead.`
  );
}

let css = prune(
  [filterCss(tokens, usedClasses), filterCss(kit, usedClasses), local].join("\n")
);

for (const [, weight] of css.matchAll(/font-weight:\s*(\d{3})/g)) {
  if (!ALLOWED_WEIGHTS.has(Number(weight))) {
    throw new Error(
      `Kept CSS uses font-weight ${weight}, which the trimmed font request does not load. ` +
        `Add it to FONTS in scripts/build-css.mjs.`
    );
  }
}

const unresolved = [...css.matchAll(/var\(\s*(--[\w-]+)/g)]
  .map((m) => m[1])
  .filter((name) => !css.includes(`${name}:`));
if (unresolved.length) {
  throw new Error(`Unresolved design tokens: ${[...new Set(unresolved)].join(", ")}`);
}

for (const forbidden of ["@import", "fonts.googleapis.com", "@charset"]) {
  if (css.includes(forbidden)) {
    throw new Error(`Generated CSS still contains "${forbidden}" — stripImports missed it`);
  }
}
if (!css.startsWith(":root{") && !css.startsWith(":root ")) {
  throw new Error(`Generated CSS should start with :root, starts with: ${css.slice(0, 60)}`);
}

let depth = 0;
for (const ch of css) {
  if (ch === "{") depth++;
  else if (ch === "}" && --depth < 0) throw new Error("Generated CSS has an unmatched }");
}
if (depth !== 0) throw new Error(`Generated CSS has ${depth} unclosed block(s)`);

// The favicon is the design system's own monogram, not a hand-drawn copy of it.
const favicon = readFileSync(
  join(DESIGN, "assets", "logos", "cns-monogram.svg"),
  "utf8"
)
  .replace(/\n+/g, "")
  .trim();

const out = `// Generated by scripts/build-css.mjs from @chrisns/design. Do not edit.
// Run \`npm run build:css\` after changing the markup or the design system.
export const CSS = ${JSON.stringify(minify(css))};
export const FONT_HREF = ${JSON.stringify(fontHref())};
export const FAVICON = ${JSON.stringify(favicon)};
`;

writeFileSync(join(ROOT, "styles.generated.js"), out);
console.log(
  `styles.generated.js: ${minify(css).length} bytes of CSS from ${usedClasses.size} classes`
);
