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

Take a newsletter such as [The AI Beat](https://www.linkedin.com/newsletters/7025619738558926848/) and use the slug or ID:

```
https://linkedinrss.cns.me/7025619738558926848
```

Full newsletter URLs with the name also work: `https://linkedinrss.cns.me/the-ai-beat-7140498537498816512`

### Article URLs

You can also paste a LinkedIn article (pulse) URL:

```
https://linkedinrss.cns.me/pulse/learning-fundamentals-beyond-slot-machine-david-knott-shrnc
```

- If the article belongs to a newsletter, you'll be redirected to the full newsletter RSS feed.
- If it's a standalone article, a single-item RSS feed is generated.

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
```

Requires Node.js 24+. Tests use [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://developers.cloudflare.com/workers/testing/vitest-integration/).
