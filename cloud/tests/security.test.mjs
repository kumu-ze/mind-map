import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, token, digest, title, cleanMap, emptyMap } from '../security.mjs';

const status = expected => error => error.status === expected;

test('password hashes use independent salts and verify only the original password', async () => {
  const password = 'local-test-password-only';
  const [one, two] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.notEqual(one, two);
  assert.equal(await verifyPassword(password, one), true);
  assert.equal(await verifyPassword('incorrect-password', one), false);
  assert.equal(await verifyPassword(null, one), false);
  assert.equal(await verifyPassword('x'.repeat(129), one), false);
});

test('password length and type validation is enforced before hashing', async () => {
  for (const invalid of [undefined, null, 123, 'short', 'x'.repeat(129)]) {
    await assert.rejects(hashPassword(invalid), status(400));
  }
});

test('tokens are URL-safe, unique, and hashes do not expose their value', () => {
  const values = new Set(Array.from({ length: 32 }, token));
  assert.equal(values.size, 32);
  for (const value of values) {
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
    assert.match(digest(value), /^[0-9a-f]{64}$/);
    assert.equal(digest(value).includes(value), false);
  }
});

test('document names are trimmed and bounded', () => {
  assert.equal(title('  Project  '), 'Project');
  assert.equal(title(undefined, 'Untitled'), 'Untitled');
  for (const invalid of ['', '   ', 'x'.repeat(121), {}]) assert.throws(() => title(invalid), status(400));
});

test('safe document contents, layout, theme, image and Unicode round-trip without input mutation', () => {
  const map = emptyMap();
  map.root.data.text = 'A & B < C and <code>literal</code>';
  map.root.children.push({ data: { text: '路线 🦊', image: 'data:image/png;base64,aGVsbG8=', hyperlink: 'https://example.test/reference' }, children: [] });
  const original = structuredClone(map);
  const cleaned = cleanMap(map);
  assert.deepEqual(cleaned, original);
  assert.deepEqual(map, original);
  assert.notEqual(cleaned, map);
});

test('rich text keeps allowed formatting but strips scripts, event handlers and executable styles', () => {
  const map = emptyMap();
  map.root.data.richText = true;
  map.root.data.text = '<p onclick="alert(1)"><strong>Heading</strong><script>alert(2)</script><img src=x onerror=alert(3)><span style="color:#ff0000;position:fixed;background-image:url(javascript:alert(4))">Detail</span></p>';
  map.root.data.note = '<a href="javascript:alert(5)" onmouseover="alert(6)">Link</a><iframe src="https://example.test"></iframe>';
  const cleaned = cleanMap(map);
  assert.match(cleaned.root.data.text, /<strong>Heading<\/strong>/);
  assert.match(cleaned.root.data.text, /color:#ff0000/);
  assert.doesNotMatch(JSON.stringify(cleaned), /script|onerror|onclick|onmouseover|position:|background-image|iframe|alert\(/i);
});

test('dangerous image and hyperlink schemes are removed, with HTTPS retained', () => {
  const map = emptyMap();
  map.root.data.hyperlink = 'javascript:alert(1)';
  map.root.data.attachmentUrl = 'java' + String.fromCharCode(10) + 'script:alert(1)';
  map.root.data.image = 'data:image/svg+xml;base64,PHN2Zz4=';
  map.theme.config.backgroundImage = 'data:text/html,<script>alert(1)</script>';
  map.root.data.url = 'https://example.test/safe';
  const cleaned = cleanMap(map);
  assert.equal(cleaned.root.data.hyperlink, '');
  assert.equal(cleaned.root.data.attachmentUrl, '');
  assert.equal(cleaned.root.data.image, '');
  assert.equal(cleaned.theme.config.backgroundImage, '');
  assert.equal(cleaned.root.data.url, 'https://example.test/safe');
});

test('prototype pollution keys are excluded at every level', () => {
  const map = JSON.parse('{"root":{"data":{"text":"Safe","__proto__":{"polluted":true}},"children":[]},"constructor":{"prototype":{"polluted":true}}}');
  const cleaned = cleanMap(map);
  assert.equal(Object.hasOwn(cleaned, 'constructor'), false);
  assert.equal(Object.hasOwn(cleaned.root.data, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('invalid document and node structure is rejected', () => {
  for (const invalid of [null, [], {}, { root: {} }, { root: { data: 'invalid' } }, { root: { data: {}, children: 'invalid' } }]) {
    assert.throws(() => cleanMap(invalid), status(400));
  }
});

test('overly deep documents and too many nodes are rejected', () => {
  const deep = emptyMap();
  let cursor = deep.root;
  for (let index = 0; index < 90; index++) {
    const child = { data: { text: 'nested' }, children: [] };
    cursor.children.push(child);
    cursor = child;
  }
  assert.throws(() => cleanMap(deep), status(400));
  const wide = emptyMap();
  wide.root.children = Array.from({ length: 5000 }, () => ({ data: { text: 'node' }, children: [] }));
  assert.throws(() => cleanMap(wide), status(400));
});

test('non-finite numbers and oversized individual resources are rejected', () => {
  const invalid = emptyMap();
  invalid.root.data.width = Infinity;
  assert.throws(() => cleanMap(invalid), status(400));
  const oversized = emptyMap();
  oversized.root.data.image = 'x'.repeat(8 * 1024 * 1024 + 1);
  assert.throws(() => cleanMap(oversized), status(413));
});



test('truthy non-boolean rich-text flags cannot bypass HTML sanitization', () => {
  for (const flag of ['yes', 1, {}, []]) {
    const map = emptyMap();
    map.root.data.richText = flag;
    map.root.data.text = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    map.root.data.generalization = [{ richText: flag, text: '<svg onload=alert(3)></svg>' }];
    let cleaned;
    try { cleaned = cleanMap(map); } catch (error) {
      assert.equal(error.status, 400);
      continue;
    }
    assert.doesNotMatch(cleaned.root.data.text, /<img|<script|onerror/i);
    assert.doesNotMatch(cleaned.root.data.generalization[0].text, /<svg|onload/i);
  }
});
