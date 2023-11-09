# LinkedIn Newsletter RSS scraper

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisns/linkedin-newsletter-rss)
[![Security Scanning](https://github.com/chrisns/linkedin-newsletter-rss/actions/workflows/security.yml/badge.svg)](https://github.com/chrisns/linkedin-newsletter-rss/actions/workflows/security.yml)

Scraper for public LinkedIn Newsletters and make them accessible by a RSS feed.

<img src="https://pbs.twimg.com/profile_images/1661161645857710081/6WtDIesg_400x400.png" alt="linkedin" width="200"/>
<img src="https://png.pngtree.com/png-vector/20190802/ourlarge/pngtree-funnel-icon-png-image_1650353.jpg" alt="funnel" width="200"/>
<img src="https://wp-assets.rss.com/blog/wp-content/uploads/2019/10/10111557/social_style_3_rss-512-1.png" alt="linkedin" width="200"/>

## Usage

Take a newsletter such as [The AI Beat](https://www.linkedin.com/newsletters/7025619738558926848/)

Notice the URL looks something like: `https://www.linkedin.com/newsletters/7025619738558926848/`

The the last bit (`7025619738558926848`) which is the newsletter ID.

Which then plonk that at the end of `https://linkedinrss.cns.me/`

Giving you an address like [`https://linkedinrss.cns.me/7025619738558926848`](https://linkedinrss.cns.me/7025619738558926848)

Put that into your favorite RSS reader and make yourself a coffee ☕ all your LinkedIn newsletters will be available in your RSS feed now!

## You can of course deploy this to your own Cloudflare worker config.
