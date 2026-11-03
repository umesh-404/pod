// Smart clipboard (core/smart-clip.ts): what each kind of copied text reads as.

import { test } from "node:test";
import assert from "node:assert/strict";

const { analyze, MAX_CLIP } = await import("../src/core/smart-clip.ts");

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const kinds = (text) => analyze(text, NOW).map((r) => r.kind);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

test("plain text, empty text and huge text read as nothing", () => {
  assert.deepEqual(analyze("", NOW), []);
  assert.deepEqual(analyze("   ", NOW), []);
  assert.deepEqual(analyze("Call Sam at four about the report", NOW), []);
  assert.deepEqual(analyze("hello", NOW), []);
  assert.deepEqual(analyze("deadbeefcafe", NOW), []);
  assert.deepEqual(analyze(`{"a":"${"x".repeat(MAX_CLIP)}"}`, NOW), []);
});

test("JWT: header and payload pretty, dates, expired note", () => {
  const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "42", iat: 1700000000, exp: 1700003600 })}.c2lnbmF0dXJl`;
  const [r, ...rest] = analyze(token, NOW);
  assert.equal(r.kind, "jwt");
  assert.equal(r.label, "JWT");
  assert.match(r.output, /"alg": "HS256"/);
  assert.match(r.output, /"sub": "42"/);
  assert.match(r.output, /^iat: /m);
  assert.match(r.output, /^exp: .*\(expired\)$/m);
  // The JWT is not also offered as base64.
  assert.ok(!rest.some((x) => x.kind === "base64"));

  const fresh = `${b64url({ alg: "none" })}.${b64url({ exp: NOW / 1000 + 3600 })}.`;
  const f = analyze(fresh, NOW)[0];
  assert.equal(f.kind, "jwt");
  assert.doesNotMatch(f.output, /expired/);
});

test("JSON is pretty-printed; scalars and broken JSON are not", () => {
  const [r] = analyze('{"a":1,"b":[true,null]}', NOW);
  assert.equal(r.kind, "json");
  assert.equal(r.output, '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
  assert.deepEqual(kinds("[1,2"), []);
  assert.deepEqual(kinds('"text"'), []);
});

test("Base64 and Base64url when they decode to text", () => {
  const [r] = analyze(Buffer.from("Hello, Pod! Ça marche.").toString("base64"), NOW);
  assert.equal(r.kind, "base64");
  assert.equal(r.label, "Base64");
  assert.equal(r.output, "Hello, Pod! Ça marche.");

  const u = analyze(Buffer.from("subjects?>>~~ok").toString("base64url"), NOW)[0];
  assert.equal(u.kind, "base64");
  assert.equal(u.output, "subjects?>>~~ok");

  // Base64 of JSON comes out pretty.
  const j = analyze(Buffer.from('{"k":"v"}').toString("base64"), NOW)[0];
  assert.equal(j.output, '{\n  "k": "v"\n}');

  // Binary does not count.
  assert.deepEqual(kinds(Buffer.from([0, 1, 2, 3, 250, 251, 252, 13, 7]).toString("base64")), []);
});

test("Unix timestamps in seconds and milliseconds, 2000–2100 only", () => {
  const s = analyze("1700000000", NOW)[0];
  assert.equal(s.kind, "timestamp");
  assert.equal(s.label, "Unix time");
  assert.match(s.output, /2023-11-14T22:13:20\.000Z/);
  assert.match(s.output, /ago$/);

  const ms = analyze(String(NOW + 3 * 86_400_000), NOW)[0];
  assert.equal(ms.kind, "timestamp");
  assert.match(ms.output, /in 3 days$/);

  assert.deepEqual(kinds("123456"), []);
  assert.deepEqual(kinds("9999999999999"), []); // year 2286
  assert.deepEqual(kinds("900000000"), []); // 1998
});

test("URL query parameters, decoded", () => {
  const [r] = analyze("https://example.com/search%20page?q=caf%C3%A9+au+lait&n=2#top%21", NOW);
  assert.equal(r.kind, "url");
  assert.equal(r.output, "https://example.com/search page\n\nq = café au lait\nn = 2\n\n#top!");
  // A bare URL has nothing to decode.
  assert.deepEqual(kinds("https://example.com/"), []);
});

test("Percent-encoded text", () => {
  const [r] = analyze("hello%20world%21", NOW);
  assert.equal(r.kind, "urlencoded");
  assert.equal(r.output, "hello world!");
  assert.deepEqual(kinds("100%"), []);
  assert.deepEqual(kinds("%E0%A4%A"), []);
});

test("Colors: hex (3, 4, 6, 8 digits) and rgb()", () => {
  assert.equal(analyze("#f80", NOW)[0].output, "#ff8800\nrgb(255, 136, 0)\nhsl(32, 100%, 50%)");
  assert.equal(analyze("#22C55E", NOW)[0].output.split("\n")[1], "rgb(34, 197, 94)");
  assert.equal(analyze("#00000080", NOW)[0].output.split("\n")[1], "rgba(0, 0, 0, 0.5)");
  const rgb = analyze("rgb(255, 255, 255)", NOW)[0];
  assert.equal(rgb.kind, "color");
  assert.equal(rgb.output.split("\n")[0], "#ffffff");
  assert.equal(analyze("rgba(10, 20, 30, 0.25)", NOW)[0].output.split("\n")[0], "#0a141e40");
  assert.deepEqual(kinds("rgb(300, 0, 0)"), []);
  assert.deepEqual(kinds("#ggg"), []);
});

test("Fast on a large input", () => {
  const big = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ i, name: `item ${i}` })) });
  assert.ok(big.length < MAX_CLIP);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) analyze(big, NOW);
  assert.ok(performance.now() - t0 < 500);
});
