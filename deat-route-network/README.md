# DEAT Global Route Network (Online Edition)

## Project Structure
- `index.html` — Main web application shell
- `styles.css` — Cartographic and DEAT editorial styling (with map SVG & marker alignment fixes)
- `app.js` — Interactive map engine, geodesic arc splitter, filters, and SHA-256 password-gated editing
- `data/network.json` — Airline network dataset (airports, routes, fleet, branding, and password hash)
- `assets/deat-emblem.svg` — DEAT brand emblem

## Hosting Online
Upload the `deat-route-network/` folder to any static web host (GitHub Pages, Netlify, Vercel, Cloudflare Pages, or standard web hosting). Because `./data/network.json` is loaded via `fetch()`, serve over `http://` or `https://` rather than `file://`.

## Password Protection
- **Default Initial Password:** `DEAT-Admin-2026!`
- All route, airport, fleet, visibility, branding, reset, and import actions require unlocking via the password modal (`sessionStorage` per browser tab).
- After unlocking, open **Backup, Security & Brand** to set a custom password and export `network.json` if you want to bake the updated hash into your hosted JSON file.
