/*
 * index.js — Lambda entrypoint for the state-lookup service.
 *
 * Runtime path is the precreated-binary resolver: cold start reads buffers only
 * (no GeoJSON parse, no index build), containment is an exact even-odd ray-cast
 * over the geometry buffer, and distance uses the precreated Flatbush index.
 *
 * Two invocation shapes so this works before an API Gateway is wired up:
 *   1. Direct invoke: { "lat": 39.0997, "lng": -94.5786 }
 *   2. API Gateway proxy (later): event.queryStringParameters = { lat, lng }
 *
 */
import { resolveState } from './binary-resolver.js';

// Strict coordinate parsing: rejects null/undefined/''/whitespace (which
// Number() silently coerces to 0) and enforces the valid range — out-of-range
// values are almost always swapped lat/lng or corrupt upstream data.
function parseCoord(v, min, max) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return NaN;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
}

export const handler = async (event = {}) => {
  const src = event.queryStringParameters || event; // gateway proxy OR direct invoke
  const lat = parseCoord(src.lat, -90, 90), lng = parseCoord(src.lng, -180, 180);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    const output = { error: 'lat (-90..90) and lng (-180..180) are required numbers' };
    console.log('[state-lookup]', JSON.stringify({ input: { lat: src.lat, lng: src.lng }, status: 400, output }));
    return respond(400, output);
  }
  const output = resolveState(lat, lng);
  console.log('[state-lookup]', JSON.stringify({ input: { lat, lng }, status: 200, output }));
  return respond(200, output);
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}
