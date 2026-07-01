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
 * `resolveState` is re-exported for IN-PROCESS use (e.g. getNearestLocations).
 */
const { resolveState } = require('./binary-resolver');

exports.handler = async (event = {}) => {
  const src = event.queryStringParameters || event; // gateway proxy OR direct invoke
  const lat = Number(src.lat), lng = Number(src.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return respond(400, { error: 'lat and lng are required numbers' });
  }
  return respond(200, resolveState(lat, lng));
};

// re-export for in-process use: require('../state-lookup/src').resolveState(lat, lng)
exports.resolveState = resolveState;

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}
