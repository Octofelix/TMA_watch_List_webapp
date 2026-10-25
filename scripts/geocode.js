// One-time helper: looks up coordinates for each destination on OpenStreetMap
// (Nominatim) and writes data/destinations.json. Respects Nominatim's 1 request/second limit.
import { readFile, writeFile } from 'node:fs/promises';

const src = JSON.parse(await readFile(new URL('./destinations-source.json', import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=mv&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'seaplane-watch/0.1 (local dev geocoding)' } });
  await sleep(1100);
  if (!res.ok) return null;
  const [hit] = await res.json();
  return hit ? { lat: +(+hit.lat).toFixed(5), lon: +(+hit.lon).toFixed(5), match: hit.display_name } : null;
}

const out = [];
for (const d of src) {
  const hit = (await search(d.island)) || (await search(d.name));
  out.push({ ...d, ...(hit || { lat: null, lon: null, match: null }) });
  console.log(hit ? 'ok  ' : 'MISS', d.name, '->', hit?.match ?? '');
}
await writeFile(new URL('../data/destinations.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} destinations (${out.filter((d) => d.lat == null).length} missing coordinates).`);
