#!/usr/bin/env node
/*
 * inflate-layer.js — DEV helper. Artifacts are STORED gzipped (layer/geo/*.gz) to
 * shrink the footprint; deploys inflate them via layer/Makefile at `sam build`.
 * Local tooling (test.js, local-server.js) reads raw files from layer/geo/ directly,
 * so this decompresses each *.gz -> raw for local use. Idempotent; runs from the
 * pre* npm hooks. Raw outputs are gitignored — the *.gz are the source of truth.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'layer', 'geo');
let n = 0;
for (const gz of fs.readdirSync(DIR).filter(f => f.endsWith('.gz'))) {
  const raw = path.join(DIR, gz.slice(0, -3));
  fs.writeFileSync(raw, zlib.gunzipSync(fs.readFileSync(path.join(DIR, gz))));
  n++;
}
console.log(`inflate-layer: ${n} artifact(s) layer/geo/*.gz -> raw (dev only; deploy uses layer/Makefile)`);
