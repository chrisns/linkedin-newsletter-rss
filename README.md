# LinkedIn Newsletter RSS scraper

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisns/linkedin-newsletter-rss)
[![Security Scanning](https://github.com/chrisns/linkedin-newsletter-rss/actions/workflows/security.yml/badge.svg)](https://github.com/chrisns/linkedin-newsletter-rss/actions/workflows/security.yml)

Scraper for public LinkedIn Newsletters and articles, making them accessible as RSS feeds.

<img src="https://pbs.twimg.com/profile_images/1661161645857710081/6WtDIesg_400x400.png" alt="linkedin" width="200"/>
<img src="https://png.pngtree.com/png-vector/20190802/ourlarge/pngtree-funnel-icon-png-image_1650353.jpg" alt="funnel" width="200"/>
<img src="https://wp-assets.rss.com/blog/wp-content/uploads/2019/10/10111557/social_style_3_rss-512-1.png" alt="linkedin" width="200"/>

## Usage

Visit [linkedinrss.cns.me](https://linkedinrss.cns.me) and paste any LinkedIn newsletter or article URL.

### Newsletter feeds

A live example. This is my own newsletter, *Cloudy with a chance of freefall*,
served as RSS by this service:

```
https://linkedinrss.cns.me/cloudy-with-chance-of-freefall-7439561267528458241
```

Source: [Cloudy with a chance of freefall](https://www.linkedin.com/newsletters/cloudy-with-chance-of-freefall-7439561267528458241/).

The numeric ID works on its own too:

```
https://linkedinrss.cns.me/7025619738558926848
```

### Article URLs

You can also paste a LinkedIn article (pulse) URL:

```
https://linkedinrss.cns.me/pulse/learning-fundamentals-beyond-slot-machine-david-knott-shrnc
```

- If the article belongs to a newsletter, you'll be redirected to the full newsletter RSS feed.
- If the article is standalone, the service looks up the author's LinkedIn profile to find all their articles and generates an "Articles by {Author}" feed.
- Falls back to a single-item feed if the author's profile can't be scraped (LinkedIn blocks some cloud IP ranges from accessing profile pages).

### Add to your RSS reader

Put the feed URL into your favourite RSS reader and you're done.

## Self hosting

You can deploy this to your own Cloudflare Worker:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisns/linkedin-newsletter-rss)

### Development

```bash
npm install
npx wrangler dev     # local dev server
npm test             # run tests
npm run build:css    # regenerate styles.generated.js
```

Requires Node.js 24+. Tests use [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://developers.cloudflare.com/workers/testing/vitest-integration/).

## What it records

The Worker writes one [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
data point per feed request: the newsletter slug, its title, and the route kind.
Nothing about the reader. The free plan includes 100,000 data points a day.

Reading costs a query against a 10,000 per day allowance, so the homepage never
queries it. A cron trigger runs the SQL every 15 minutes and writes the top 20
to KV; the homepage reads one key. That is 96 KV writes a day against a free
allowance of 1,000.

Both bindings are optional. Without them the Worker still serves feeds, and the
homepage omits the most-followed panel.

To turn the panel on:

```bash
npx wrangler kv namespace create POPULAR
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ANALYTICS_TOKEN   # needs Account Analytics: Read
```

Then paste the namespace id into `wrangler.toml` and uncomment the
`kv_namespaces` and `triggers` blocks.

## How it works

### Parsing

The Worker parses with [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/),
which runs in native code and streams. It does not build a DOM in JavaScript.
This matters: the free plan allows 10ms of CPU per request, and a LinkedIn
article page is about 225KB.

Two details are worth knowing before you change `parse.js`.

1. **Text chunks and attribute values arrive raw.** Character references are not
   decoded, so re-emitting them is lossless. Decode explicitly when you need a
   real value.
2. **A content token is only valid inside its own handler.** Copy anything an
   `onEndTag` callback needs, the tag name above all, into a local first.

The article body is extracted by marking its container with sentinels and
slicing the transformed output. Capturing it through `text` callbacks instead
costs about 15us per chunk, and a body arrives as roughly 978 chunks.

### Styling

The pages use the [CNS design system](https://github.com/chrisns/design).
`scripts/build-css.mjs` reads the tokens and the govbuy UI kit from
`node_modules`, keeps only the rules whose selectors name a class the pages
actually use, and writes `styles.generated.js`. The Worker inlines that.

`styles.generated.js` is committed, because the deploy job installs with
`--omit=dev` and cannot rebuild it. CI regenerates it and fails on a diff.

`styles.local.css` holds the one component the design system does not have, a
form input. Every value in it is a design token; the build fails on a raw
colour.
