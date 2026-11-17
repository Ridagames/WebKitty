import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("index.html", "utf8");
const hens = fs.readFileSync("includes/js/HENs.js", "utf8");
const afterglow = fs.readFileSync("src/slopkit-afterglow/jb.js", "utf8");

assert.match(html, /id="silverhen-label-initial"[\s\S]*?name="hen" value="SilverHEN"/);
assert.match(html, /id="silverhen-label-exploit"[\s\S]*?name="hen2" value="SilverHEN"/);
assert.equal((html.match(/value="SilverHEN"/g) || []).length, 2,
  "SilverHEN must appear once in each synchronized selector");

assert.match(hens, /function SilverHEN\(\)[\s\S]*?silverhen\.bin\.b64/);
assert.match(hens, /user\.currentJbFlavor === 'SilverHEN'[\s\S]*?SilverHEN\(\)/);
assert.match(hens, /hideSilverHEN = \(fwNum !== 14\.02\)/);
assert.match(hens, /toggleVisibility\(silverHENInputInitial\.id, !hideSilverHEN\)/);
assert.match(afterglow, /silverhen\.bin(?:\\\.b64)?/);

console.log("SilverHEN selector tests passed");
