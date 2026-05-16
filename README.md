# BizRadar — Global Business Intelligence Map

## Architecture

```
Browser → Fastify (Render) → Overpass API / Nominatim
                ↓
         /public/index.html  (served as static)
```

One Render Web Service handles everything — no CORS issues, no external API calls from the browser.

## Local Development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

## Deploy to Render

### Option A — Render Dashboard (easiest)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Node version:** 20+
5. Click Deploy

### Option B — render.yaml (auto-config)

The `render.yaml` is already included. Just connect your repo in Render and it will auto-detect the config.

## API Routes

| Route | Method | Description |
|---|---|---|
| `/api/search-location?q=...` | GET | Location search (Nominatim) |
| `/api/scan-area` | POST `{lat,lng,radius,category}` | Business scan (Overpass) |
| `/api/reverse-geocode?lat=&lng=` | GET | Reverse geocode (Nominatim) |

## Data Sources

- **OpenStreetMap** — map tiles
- **Overpass API** — realtime business data (3 fallback endpoints)
- **Nominatim** — location search & geocoding
