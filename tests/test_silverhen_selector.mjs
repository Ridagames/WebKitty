import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("index.html", "utf8");
const hens = fs.readFileSync("includes/js/HENs.js", "utf8");
const afterglow = fs.readFileSync("src/slopkit-afterglow/jb.js", "utf8");
const afterglowRuntime = fs.readFileSync("src/slopkit-afterglow/afterglow.js", "utf8");

assert.match(html, /id="silverhen-label-initial"[\s\S]*?name="hen" value="SilverHEN"/);
assert.match(html, /id="silverhen-label-exploit"[\s\S]*?name="hen2" value="SilverHEN"/);
assert.equal((html.match(/value="SilverHEN"/g) || []).length, 2,
  "SilverHEN must appear once in each synchronized selector");

assert.match(hens, /user\.currentJbFlavor === 'SilverHEN'[\s\S]*?SilverHEN\(\)/);
assert.match(hens, /hideSilverHEN = \(fwNum !== 14\.02\)/);
assert.match(hens, /toggleVisibility\(silverHENInputInitial\.id, !hideSilverHEN\)/);


assert.match(afterglowRuntime, /silverhen-ps4-14\.02-build-158\/silverhen\.bin/);
assert.match(afterglowRuntime, /DEFAULT_SILVERHEN_PAYLOAD_SIZE = 7442/);
assert.match(afterglowRuntime, /savedBlob\.length !== DEFAULT_SILVERHEN_PAYLOAD_SIZE/);
assert.match(afterglowRuntime, /waitForSilverhenPayload\(bridge, 15000, 10\)/);
assert.match(afterglowRuntime, /native payload reports READY/);

assert.match(afterglowRuntime, /DEFAULT_SILVERHEN_PAYLOAD_BASE64/);
assert.ok(hens.includes("https://raw.githubusercontent.com/Ridagames/RIDA-HEN/main/payload/releases/silverhen-ps4-14.02-build-158.bin.b64"));
assert.ok(afterglow.includes("https://raw.githubusercontent.com/Ridagames/RIDA-HEN/main/payload/releases/silverhen-ps4-14.02-build-158.bin.b64"));
console.log("SilverHEN selector tests passed");
