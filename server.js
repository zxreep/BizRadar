import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ── Data Sources ──────────────────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOM_HEADERS = { 'Accept-Language': 'en', 'User-Agent': 'BizRadar/1.0 (open-source)' };

// ── In-memory cache ───────────────────────────────────────────────────────
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.data;
  const data = await fn();
  cache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}

// ── App ───────────────────────────────────────────────────────────────────
const app = Fastify({ logger: true }); // logger ON so errors show in Render logs

// Serve frontend
app.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });

// FIX: explicit root route — without this, / returns 404
app.get('/', (req, reply) => reply.sendFile('index.html'));

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/api/search-location', async (req, reply) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return reply.code(400).send({ error: 'Query too short' });
    const url = `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=0`;
    const data = await cached('nom:' + q.toLowerCase(), 300_000, () =>
      timedFetch(url, { headers: NOM_HEADERS }, 10_000).then(r => r.json())
    );
    return reply.send(data);
  } catch (err) {
    app.log.error('search-location: ' + err.message);
    return reply.code(500).send({ error: err.message });
  }
});

app.get('/api/reverse-geocode', async (req, reply) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return reply.code(400).send({ error: 'lat/lng required' });
    const url = `${NOMINATIM}/reverse?lat=${lat}&lon=${lng}&format=json`;
    const data = await cached(`rev:${(+lat).toFixed(4)},${(+lng).toFixed(4)}`, 3_600_000, () =>
      timedFetch(url, { headers: NOM_HEADERS }, 10_000).then(r => r.json())
    );
    return reply.send(data);
  } catch (err) {
    app.log.error('reverse-geocode: ' + err.message);
    return reply.code(500).send({ error: err.message });
  }
});

// Business scan — Overpass primary, Nominatim as fallback
app.post('/api/scan-area', async (req, reply) => {
  try {
    const { lat, lng, radius = 500, category = 'all' } = req.body ?? {};
    if (lat == null || lng == null) return reply.code(400).send({ error: 'lat/lng required' });

    const cacheKey = `scan:${(+lat).toFixed(4)},${(+lng).toFixed(4)},${radius},${category}`;
    const data = await cached(cacheKey, 120_000, async () => {
      // Try Overpass first (richer data)
      try {
        return await fetchOverpass(buildOverpassQuery(+lat, +lng, +radius, category));
      } catch (e) {
        app.log.warn('Overpass failed (' + e.message + '), using Nominatim fallback');
      }
      // Fallback: Nominatim area search (always available, less detailed)
      return await fetchNominatimArea(+lat, +lng, +radius, category);
    });

    return reply.send(data);
  } catch (err) {
    app.log.error('scan-area: ' + err.message);
    return reply.code(500).send({ error: err.message });
  }
});

// ── Overpass ──────────────────────────────────────────────────────────────

async function fetchOverpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await timedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      }, 28_000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      if (!json.elements) throw new Error('Unexpected Overpass response');
      app.log.info('Overpass OK: ' + json.elements.length + ' elements via ' + endpoint);
      return json;
    } catch (e) {
      app.log.warn('Overpass ' + endpoint + ' failed: ' + e.message);
      lastErr = e;
    }
  }
  throw new Error('All Overpass endpoints failed: ' + lastErr?.message);
}

const CAT_MAP = {
  restaurant: ['amenity~"restaurant|cafe|fast_food|bar|pub"'],
  shop:        ['shop'],
  healthcare:  ['amenity~"pharmacy|hospital|clinic|doctors|dentist"'],
  hotel:       ['tourism~"hotel|hostel|motel|guest_house"'],
  bank:        ['amenity~"bank|atm|bureau_de_change"'],
  education:   ['amenity~"school|university|college|library"']
};

function buildOverpassQuery(lat, lng, radius, category) {
  const nf = `["name"](around:${radius},${lat},${lng})["name"!~"^$"]`;
  let unions;
  if (!category || category === 'all') {
    unions = [
      `node[amenity]${nf}`,
      `node[shop]${nf}`,
      `node[tourism~"hotel|hostel|motel|guest_house"]${nf}`
    ];
  } else {
    const filters = CAT_MAP[category] || [];
    unions = filters.flatMap(f => [`node[${f}]${nf}`, `way[${f}]${nf}`]);
    if (!unions.length) unions = [`node[amenity]${nf}`];
  }
  return `[out:json][timeout:25];(${unions.join('')});out center 80;`;
}

// ── Nominatim area fallback ───────────────────────────────────────────────
// Nominatim supports amenity= param + viewbox bounding — no key needed

const NOM_TERMS = {
  all:        ['restaurant', 'cafe', 'pharmacy', 'shop', 'bank', 'hotel', 'school'],
  restaurant: ['restaurant', 'cafe', 'fast_food', 'bar', 'pub'],
  shop:        ['supermarket', 'convenience', 'clothes', 'electronics', 'bakery'],
  healthcare:  ['pharmacy', 'hospital', 'clinic', 'doctors', 'dentist'],
  hotel:       ['hotel', 'hostel', 'motel', 'guest_house'],
  bank:        ['bank', 'atm'],
  education:   ['school', 'university', 'college', 'library']
};

async function fetchNominatimArea(lat, lng, radius, category) {
  const deg = (radius / 111_000) * 1.5;
  const viewbox = `${lng - deg},${lat + deg},${lng + deg},${lat - deg}`;
  const terms = (NOM_TERMS[category] || NOM_TERMS.all).slice(0, 4);

  const results = await Promise.allSettled(
    terms.map(term =>
      timedFetch(
        `${NOMINATIM}/search?format=json&limit=25&addressdetails=1&bounded=1&viewbox=${viewbox}&amenity=${encodeURIComponent(term)}`,
        { headers: NOM_HEADERS }, 10_000
      ).then(r => r.json())
    )
  );

  const merged = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value || []);

  // Deduplicate by osm_id
  const seen = new Set();
  const unique = merged.filter(i => {
    if (seen.has(i.osm_id)) return false;
    seen.add(i.osm_id);
    return true;
  });

  app.log.info('Nominatim fallback: ' + unique.length + ' results');
  return nominatimToOverpassFormat(unique);
}

// Convert Nominatim items → Overpass {elements:[]} shape
// so frontend processElements() works unchanged
function nominatimToOverpassFormat(items) {
  const elements = items
    .filter(i => i.lat && i.lon)
    .map(i => ({
      type: 'node',
      id: parseInt(i.osm_id) || (Math.random() * 1e9 | 0),
      lat: parseFloat(i.lat),
      lon: parseFloat(i.lon),
      tags: {
        name:            (i.namedetails?.name || i.display_name?.split(',')[0] || '').trim(),
        amenity:         i.class === 'amenity'  ? i.type  : undefined,
        shop:            i.class === 'shop'     ? i.type  : undefined,
        tourism:         i.class === 'tourism'  ? i.type  : undefined,
        'addr:housenumber': i.address?.house_number,
        'addr:street':      i.address?.road,
        'addr:city':        i.address?.city || i.address?.town || i.address?.village,
        'addr:country':     i.address?.country_code?.toUpperCase()
      }
    }))
    .filter(e => e.tags.name); // drop nameless entries

  return { elements, _source: 'nominatim_fallback' };
}

// ── Fetch with timeout ────────────────────────────────────────────────────
function timedFetch(url, opts = {}, ms = 15_000) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(tid));
}

// ── Start ─────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
});
