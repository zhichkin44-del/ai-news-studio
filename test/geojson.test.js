import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, parseGeoJson, fetchFeed } from '../src/collect.js';

const quake = (id, mag, over = {}) => ({
  id,
  properties: { mag, place: '10 km S of Test', time: Date.parse('2026-10-28T10:00:00Z'), url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, title: `M ${mag} - 10 km S of Test`, tsunami: 0, ...over },
  geometry: { type: 'Point', coordinates: [100, 10, 35.4] },
});
const JSON_TEXT = JSON.stringify({ type: 'FeatureCollection', features: [quake('us1', 6.2, { tsunami: 1, alert: 'orange' }), quake('us2', 4.6), quake('us3', 5), { id: 'bad', properties: { mag: null } }] });
const SRC = { id: 'usgs-quakes', format: 'geojson', min_mag: 5 };

test('parseGeoJson: землетрясения M5+, слабые и битые записи отброшены', () => {
  const items = parseGeoJson(JSON_TEXT, SRC);
  assert.deepEqual(items.map((i) => i.id), ['usgs-quakes:us1', 'usgs-quakes:us3']);
  const [q] = items;
  assert.equal(q.title, 'M 6.2 - 10 km S of Test');
  assert.equal(q.published, '2026-10-28T10:00:00.000Z');
  assert.equal(q.source, 'usgs-quakes');
  assert.match(q.link, /^https:\/\/earthquake\.usgs\.gov\//);
  assert.match(q.summary, /magnitude 6\.2/);
  assert.match(q.summary, /Depth 35 km/);
  assert.match(q.summary, /Tsunami/);
  assert.match(q.summary, /orange/);
});

test('parseGeoJson: без min_mag берёт всё; мусор вместо JSON — пустой список', () => {
  assert.equal(parseGeoJson(JSON_TEXT, { id: 'u' }).length, 3);
  assert.deepEqual(parseGeoJson('<html>oops</html>', SRC), []);
  assert.deepEqual(parseGeoJson('{"features": null}', SRC), []);
});

test('parseFeed: JSON определяется по формату и по первому символу, RSS не задет', () => {
  assert.equal(parseFeed(JSON_TEXT, SRC).length, 2);
  assert.equal(parseFeed(`  \n${JSON_TEXT}`, { id: 'u', min_mag: 6 }).length, 1);
  const rss = readFileSync(new URL('./fixtures/a.rss.xml', import.meta.url), 'utf8');
  assert.ok(parseFeed(rss, { id: 'a' }).length > 0);
});

test('fetchFeed: GeoJSON приходит через общий путь загрузки', async () => {
  const bytes = new TextEncoder().encode(JSON_TEXT);
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer, headers: { get: () => 'application/json' } });
  const items = await fetchFeed({ ...SRC, url: 'https://example.org/q.geojson' }, { fetchImpl });
  assert.equal(items.length, 2);
});

test('sources.json: USGS описан как geojson с порогом магнитуды, статус-страницы — Atom', () => {
  const { sources } = JSON.parse(readFileSync(new URL('../sources.json', import.meta.url), 'utf8'));
  const usgs = sources.find((s) => s.id === 'usgs-quakes');
  assert.equal(usgs.format, 'geojson');
  assert.ok(usgs.min_mag >= 5);
  for (const id of ['status-anthropic', 'status-openai', 'status-github', 'status-google-cloud']) {
    assert.equal(sources.find((s) => s.id === id).category, 'tech');
  }
});
