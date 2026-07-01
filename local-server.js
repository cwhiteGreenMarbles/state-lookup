// Tiny local runner so the service can be exercised without SAM/AWS.
// Delegates to the REAL Lambda handler so local behavior (validation, headers,
// response shape) is identical to the deployed function.
//   npm start   ->   curl 'http://localhost:8080/geo/state?lat=39.0997&lng=-94.5786'
const http = require('http');
const url = require('url');
const { handler } = require('./src');

const PORT = process.env.PORT || 8080;
http.createServer(async (req, res) => {
  const q = url.parse(req.url, true).query;
  const r = await handler({ queryStringParameters: q });
  res.writeHead(r.statusCode, r.headers);
  res.end(r.body);
}).listen(PORT, () => console.log('state-lookup listening on :' + PORT));
