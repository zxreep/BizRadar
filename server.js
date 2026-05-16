import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

// In-memory cache: key → { data, expires }
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.data;
  const data = await fn();
  cache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}

const app = Fastify({ logger: false });

// Serve frontend from /public
app.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/api/search-location', async (req, reply) => {
  const { q } = req.query;
  if (!q || q.length < 2) return reply.code(400).send({ error: 'Query too short' });
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=0`;
  const data = await cached('nom:' + q.toLowerCase(), 300_000, () =>
    fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'BizRadar/1.0' } }).then(r => r.json())
  );
  return reply.send(data);
});

app.post('/api/scan-area', async (req, reply) => {
  const { lat, lng, radius = 500, category = 'all' } = req.body ?? {};
  if (!lat || !lng) return reply.code(400).send({ error: 'lat/lng required' });
  const query = buildQuery(lat, lng, radius, category);
  const key = `ovp:${(+lat).toFixed(4)},${(+lng).toFixed(4)},${radius},${category}`;
  const data = await cached(key, 120_000, () => fetchOverpass(query));
  return reply.send(data);
});

app.get('/api/reverse-geocode', async (req, reply) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return reply.code(400).send({ error: 'lat/lng required' });
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
  const data = await cached(`rev:${(+lat).toFixed(4)},${(+lng).toFixed(4)}`, 3_600_000, () =>
    fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'BizRadar/1.0' } }).then(r => r.json())
  );
  return reply.send(data);
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchOverpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 30_000);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: ac.signal
      });
      clearTimeout(tid);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { clearTimeout(tid); lastErr = e; }
  }
  throw new Error('All Overpass endpoints failed: ' + lastErr?.message);
}

const CAT_MAP = {
  restaurant: ['amenity~"restaurant|cafe|fast_food|bar|pub"'],
  shop: ['shop'],
  healthcare: ['amenity~"pharmacy|hospital|clinic|doctors|dentist"', 'healthcare'],
  hotel: ['tourism~"hotel|hostel|motel|guest_house"'],
  bank: ['amenity~"bank|atm|bureau_de_change"'],
  education: ['amenity~"school|university|college|library"']
};

function buildQuery(lat, lng, radius, category) {
  const nf = `["name"](around:${radius},${lat},${lng})["name"!~"^$"]`;
  let unions;
  if (!category || category === 'all') {
    unions = [
      `node[amenity]${nf}`, `node[shop]${nf}`,
      `node[tourism~"hotel|hostel|motel|guest_house"]${nf}`,
      `node[leisure~"fitness_centre|sports_centre|cinema"]${nf}`
    ];
  } else {
    const filters = CAT_MAP[category] || [];
    unions = filters.flatMap(f => [`node[${f}]${nf}`, `way[${f}]${nf}`]);
    if (!unions.length) unions = [`node[amenity]${nf}`, `node[shop]${nf}`];
  }
  return `[out:json][timeout:30];(${unions.join('')});out center 100;`;
}

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`BizRadar on :${PORT}`);
});
