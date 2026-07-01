// Tiny local runner so the service can be exercised without SAM/AWS.
//   npm start   ->   curl 'http://localhost:8080/geo/state?lat=39.0997&lng=-94.5786'
const http = require('http');
const url = require('url');
const { resolveState } = require('./src/binary-resolver');

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  const q = url.parse(req.url, true).query;
  const lat = Number(q.lat), lng = Number(q.lng);
  res.setHeader('content-type', 'application/json');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'lat and lng query params required' }));
  }
  res.end(JSON.stringify(resolveState(lat, lng)));
}).listen(PORT, () => console.log('state-lookup listening on :' + PORT));
