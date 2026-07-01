/*
 * index.js — Lambda entrypoint for the state-lookup service.
 *
 * Two invocation shapes are supported so this works before an API Gateway is wired up:
 *   1. Direct invoke: { "lat": 39.0997, "lng": -94.5786 }
 *   2. API Gateway proxy (later): event.queryStringParameters = { lat, lng }
 *
 * The core is exported from ./state-resolver so getNearestLocations (or any other
 * handler) can require it and call resolveState(lat,lng) IN-PROCESS, with no HTTP hop.
 */
const { resolveState } = require('./state-resolver');

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
