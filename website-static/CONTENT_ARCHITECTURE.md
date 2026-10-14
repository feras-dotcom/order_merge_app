# Future content architecture

The public site stays buildless until there is real guide content. When guides are ready, add a small Node-based static build step rather than a CMS.

Each guide should live in `content/guides/<slug>.md` with front matter for:

- `title`
- `description`
- `published`
- `updated`
- `canonical`
- `image` and `imageAlt`

The future build should generate `/guides/index.html`, `/guides/<slug>/index.html`, Article or BlogPosting JSON-LD, Open Graph metadata, related internal links, and sitemap entries from those files. The Guides navigation item should only be rendered once at least one real guide exists.

Potential evergreen product pages such as `/combine-shopify-orders`, `/product-drops`, and `/preorders` should remain hand-authored product pages, not generated as thin guide content.
