import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../app.mjs';
import { migrate } from '../db.mjs';
import { hashPassword, emptyMap } from '../security.mjs';

// Explicit opt-in only. DATABASE_URL is deliberately ignored to prevent accidental
// tests against the app's normal database. All records live in a fresh schema.
const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:41737';
const password = 'integration-test-password-only';
const schema = 'mindmap_test_' + randomUUID().replaceAll('-', '');
let maintenance, pool, server, baseUrl, createdSchema = false;
let admin, alice, bob;
let serial = 0;

function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(/^(password|password_hash|token_hash|csrf|sessionHash)$/i.test(key), false, 'response contains a secret field');
    noSecrets(nested);
  }
}
async function request(route, { method = 'GET', session, body, requestOrigin = origin, csrf, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (requestOrigin !== null) allHeaders.Origin = requestOrigin;
  if (session) {
    allHeaders.Cookie = session.cookie;
    if (csrf === undefined) allHeaders['X-CSRF-Token'] = session.csrf;
  }
  if (csrf !== undefined && csrf !== null) allHeaders['X-CSRF-Token'] = csrf;
  if (body !== undefined) allHeaders['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + '/mindmap/api' + route, { method, headers: allHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  noSecrets(data);
  return { status: response.status, data, headers: response.headers };
}
function success(result, expected = 200) {
  assert.equal(result.status, expected, 'unexpected HTTP status');
  return result.data;
}
async function login(username, pwd = password) {
  const result = await request('/auth/login', { method: 'POST', body: { username, password: pwd } });
  const data = success(result);
  const cookie = result.headers.get('set-cookie');
  assert.ok(cookie?.startsWith('konon_mindmap='), 'login sets the session cookie');
  return { cookie: cookie.split(';')[0], csrf: data.csrfToken, user: data.user };
}
async function invite() {
  return success(await request('/admin/invites', { method: 'POST', session: admin, body: {} }), 201).invite;
}
async function register(code, username = 'new_user_' + ++serial) {
  return request('/auth/register', { method: 'POST', body: { invite: code, username, displayName: 'New user', password } });
}
async function createMap(session = alice, extra = {}) {
  return success(await request('/maps', { method: 'POST', session, body: { title: 'Test map ' + ++serial, data: emptyMap(), ...extra } }), 201).map;
}
async function share(mapId, session = alice) {
  return success(await request('/maps/' + mapId + '/shares', { method: 'POST', session, body: { days: 7 } }), 201).share;
}
const shareToken = value => new URL(value.url).pathname.split('/').at(-1);

// Subtests are serial so database fixtures and rate-limiter budgets are predictable.
describe('cloud API integration against an isolated PostgreSQL schema', { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    assert.match(schema, /^mindmap_test_[a-f0-9]{32}$/);
    maintenance = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await maintenance.query('CREATE SCHEMA "' + schema + '"');
    createdSchema = true;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: '-c search_path=' + schema });
    await migrate(pool);
    const hashed = await hashPassword(password);
    for (const [username, role] of [['admin_test', 'admin'], ['alice_test', 'user'], ['bob_test', 'user']]) {
      await pool.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)', [randomUUID(), username, username, hashed, role]);
    }
    const app = createApp({ pool, publicUrl: origin + '/mindmap/', secureCookies: false });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    admin = await login('admin_test');
    alice = await login('alice_test');
    bob = await login('bob_test');
  });
  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (pool) await pool.end();
    if (maintenance) {
      // The only DROP target is the exact random schema successfully created above.
      if (createdSchema) await maintenance.query('DROP SCHEMA "' + schema + '" CASCADE');
      await maintenance.end();
    }
  });

  it('returns public session fields, secure cookie attributes and no-cache headers', async () => {
    const result = await request('/auth/login', { method: 'POST', body: { username: '  ALICE_TEST  ', password } });
    const data = success(result);
    assert.deepEqual(Object.keys(data.user).sort(), ['displayName', 'id', 'role', 'username']);
    assert.equal(data.user.username, 'alice_test');
    assert.match(data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const cookie = result.headers.get('set-cookie');
    assert.ok(/HttpOnly/i.test(cookie));
    assert.ok(/SameSite=Strict/i.test(cookie));
    assert.ok(/Path=\/mindmap\//i.test(cookie));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(success(await request('/session', { session: alice })).user.id, alice.user.id);
    assert.equal((await request('/maps')).status, 401);
    assert.equal((await request('/session', { headers: { Cookie: 'konon_mindmap=invalid-session' } })).status, 401);
  });

  it('rejects invalid login, cross-origin writes, missing CSRF and Unicode CSRF without server errors', async () => {
    assert.equal((await request('/auth/login', { method: 'POST', requestOrigin: null, body: { username: 'alice_test', password } })).status, 403);
    assert.equal((await request('/auth/login', { method: 'POST', requestOrigin: 'https://untrusted.example', body: { username: 'alice_test', password } })).status, 403);
    assert.equal((await request('/auth/login', { method: 'POST', body: { username: 'alice_test', password: 'incorrect-password' } })).status, 401);
    assert.equal((await request('/auth/login', { method: 'POST', body: { username: 'does_not_exist', password } })).status, 401);
    for (const csrf of [null, 'x'.repeat(43), '\u00e9'.repeat(43)]) {
      assert.equal((await request('/folders', { method: 'POST', session: alice, csrf, body: { name: 'must not exist' } })).status, 403);
    }
    assert.equal((await request('/folders', { method: 'POST', session: alice, requestOrigin: 'https://untrusted.example', body: { name: 'must not exist' } })).status, 403);
    assert.equal(success(await request('/folders', { session: alice })).folders.length, 0);
  });

  it('requires a valid single-use invite and rejects expired or revoked invitations', async () => {
    const valid = await invite();
    const registered = success(await register(valid.code), 201);
    assert.equal(registered.user.role, 'user');
    assert.equal((await register(valid.code)).status, 400);
    const expired = await invite();
    await pool.query("UPDATE invites SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    assert.equal((await register(expired.code)).status, 400);
    const revoked = await invite();
    success(await request('/admin/invites/' + revoked.id, { method: 'DELETE', session: admin }));
    assert.equal((await register(revoked.code)).status, 400);
    assert.equal((await register('not-a-valid-invite')).status, 400);
  });

  it('does not consume an invitation when a duplicate username rolls registration back', async () => {
    const valid = await invite();
    assert.equal((await register(valid.code, 'alice_test')).status, 409);
    const row = (await pool.query('SELECT used_by FROM invites WHERE id=$1', [valid.id])).rows[0];
    assert.equal(row.used_by, null);
    success(await register(valid.code), 201);
  });

  it('allows exactly one registration in a concurrent race for the same invite', async () => {
    const valid = await invite();
    const results = await Promise.all([register(valid.code), register(valid.code)]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
  });

  it('restricts invitation administration to admins and never lists invitation secrets', async () => {
    assert.equal((await request('/admin/invites', { session: alice })).status, 403);
    assert.equal((await request('/admin/invites', { method: 'POST', session: alice, body: {} })).status, 403);
    const data = success(await request('/admin/invites', { session: admin }));
    assert.ok(data.invites.length > 0);
    assert.equal(data.invites.some(item => Object.hasOwn(item, 'code')), false);
  });

  it('isolates folders and rejects assignment to another user folder on create or update', async () => {
    const folder = success(await request('/folders', { method: 'POST', session: alice, body: { name: 'Private folder' } }), 201).folder;
    assert.equal(success(await request('/folders', { session: bob })).folders.some(item => item.id === folder.id), false);
    assert.equal((await request('/folders/' + folder.id, { method: 'PATCH', session: bob, body: { name: 'Stolen' } })).status, 404);
    assert.equal((await request('/folders/' + folder.id, { method: 'DELETE', session: bob })).status, 404);
    assert.equal((await request('/maps', { method: 'POST', session: bob, body: { title: 'Wrong folder', folderId: folder.id } })).status, 404);
    const bobsMap = await createMap(bob);
    assert.equal((await request('/maps/' + bobsMap.id, { method: 'PUT', session: bob, body: { version: bobsMap.version, folderId: folder.id } })).status, 404);
    const own = await createMap(alice, { folderId: folder.id });
    success(await request('/folders/' + folder.id, { method: 'DELETE', session: alice }));
    const saved = success(await request('/maps/' + own.id, { session: alice })).map;
    assert.equal(saved.folder_id, null);
    assert.equal(saved.id, own.id);
  });

  it('isolates map reads, writes, copying, deletion, history and shares across accounts', async () => {
    const map = await createMap();
    assert.equal(success(await request('/maps', { session: bob })).maps.some(item => item.id === map.id), false);
    for (const [method, suffix, body] of [
      ['GET', '', undefined], ['PUT', '', { version: map.version, title: 'Stolen' }], ['DELETE', '', undefined],
      ['POST', '/duplicate', {}], ['POST', '/restore', {}], ['GET', '/revisions', undefined],
      ['GET', '/shares', undefined], ['POST', '/shares', { days: 7 }]
    ]) assert.equal((await request('/maps/' + map.id + suffix, { method, session: bob, body })).status, 404);
    const reread = success(await request('/maps/' + map.id, { session: alice })).map;
    assert.equal(reread.title, map.title);
    assert.equal(reread.version, map.version);
    assert.equal((await request('/maps/not-a-uuid', { session: alice })).status, 404);
  });

  it('prevents stale and simultaneous saves from overwriting the accepted document', async () => {
    const map = await createMap();
    const first = success(await request('/maps/' + map.id, { method: 'PUT', session: alice, body: { version: map.version, title: 'Accepted' } })).map;
    const stale = await request('/maps/' + map.id, { method: 'PUT', session: alice, body: { version: map.version, title: 'Stale' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'VERSION_CONFLICT');
    assert.equal(success(await request('/maps/' + map.id, { session: alice })).map.title, 'Accepted');
    const competing = await Promise.all(['Candidate A', 'Candidate B'].map(name => request('/maps/' + map.id, { method: 'PUT', session: alice, body: { version: first.version, title: name } })));
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    const winner = competing.find(result => result.status === 200).data.map;
    const saved = success(await request('/maps/' + map.id, { session: alice })).map;
    assert.equal(saved.title, winner.title);
    assert.equal(saved.version, first.version + 1);
    assert.equal(success(await request('/maps/' + map.id + '/revisions', { session: alice })).revisions.length, 2);
  });

  it('restores document data and title from history and refuses stale or foreign revision restores', async () => {
    const data1 = emptyMap(); data1.root.data.text = 'Original body';
    const map = await createMap(alice, { title: 'Original title', data: data1 });
    const data2 = emptyMap(); data2.root.data.text = 'Later body';
    const updated = success(await request('/maps/' + map.id, { method: 'PUT', session: alice, body: { version: map.version, title: 'Later title', data: data2 } })).map;
    const revisions = success(await request('/maps/' + map.id + '/revisions', { session: alice })).revisions;
    assert.equal(revisions.length, 1);
    const restorePath = '/maps/' + map.id + '/revisions/' + revisions[0].id + '/restore';
    assert.equal((await request(restorePath, { method: 'POST', session: bob, body: { version: updated.version } })).status, 404);
    assert.equal((await request(restorePath, { method: 'POST', session: alice, body: { version: map.version } })).status, 409);
    const unrelated = await createMap();
    assert.equal((await request('/maps/' + unrelated.id + '/revisions/' + revisions[0].id + '/restore', { method: 'POST', session: alice, body: { version: unrelated.version } })).status, 404);
    const restored = success(await request(restorePath, { method: 'POST', session: alice, body: { version: updated.version } })).map;
    assert.equal(restored.title, 'Original title');
    assert.equal(restored.data.root.data.text, 'Original body');
    assert.equal(restored.version, updated.version + 1);
    assert.equal(success(await request('/maps/' + map.id + '/revisions', { session: alice })).revisions.length, 2);
  });

  it('caps stored revisions at the latest twenty without removing current data', async () => {
    let map = await createMap();
    for (let index = 0; index < 22; index++) {
      map = success(await request('/maps/' + map.id, { method: 'PUT', session: alice, body: { version: map.version, title: 'Revision ' + index } })).map;
    }
    const revisions = success(await request('/maps/' + map.id + '/revisions', { session: alice })).revisions;
    assert.equal(revisions.length, 20);
    assert.equal(revisions[0].version, map.version - 1);
    assert.equal(revisions.at(-1).version, map.version - 20);
    assert.equal(success(await request('/maps/' + map.id, { session: alice })).map.title, 'Revision 21');
  });

  it('provides anonymous read-only shares without owner metadata or a write capability', async () => {
    const map = await createMap();
    const link = await share(map.id);
    const publicPath = '/public/shares/' + shareToken(link);
    const shared = success(await request(publicPath, { requestOrigin: null }));
    assert.equal(shared.readonly, true);
    assert.equal(shared.map.title, map.title);
    assert.deepEqual(shared.map.data, map.data);
    assert.equal(Object.hasOwn(shared.map, 'owner_id'), false);
    assert.equal(Object.hasOwn(shared.map, 'folder_id'), false);
    assert.equal((await request('/maps/' + map.id, { method: 'PUT', body: { version: map.version, title: 'Anonymous edit' } })).status, 401);
    assert.equal((await request(publicPath, { method: 'PUT', body: { title: 'Anonymous edit' } })).status, 401);
    assert.equal((await request('/maps/' + map.id, { method: 'PUT', session: bob, body: { version: map.version, title: 'Another user edit' } })).status, 404);
    const listed = success(await request('/maps/' + map.id + '/shares', { session: alice })).shares;
    assert.equal(listed.some(item => Object.hasOwn(item, 'url')), false);
    assert.equal(success(await request('/maps/' + map.id, { session: alice })).map.title, map.title);
  });

  it('makes revoked and expired share tokens inaccessible', async () => {
    const map = await createMap();
    const revoked = await share(map.id);
    assert.equal((await request('/maps/' + map.id + '/shares/' + revoked.id, { method: 'DELETE', session: bob })).status, 404);
    success(await request('/maps/' + map.id + '/shares/' + revoked.id, { method: 'DELETE', session: alice }));
    assert.equal((await request('/public/shares/' + shareToken(revoked))).status, 404);
    const expired = await share(map.id);
    await pool.query("UPDATE shares SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    assert.equal((await request('/public/shares/' + shareToken(expired))).status, 404);
    assert.equal((await request('/public/shares/not-a-token')).status, 404);
  });

  it('moves documents to owner-only trash and never reactivates old links on restore', async () => {
    const map = await createMap();
    const link = await share(map.id);
    success(await request('/maps/' + map.id, { method: 'DELETE', session: alice }));
    assert.equal((await request('/maps/' + map.id, { session: alice })).status, 404);
    assert.equal((await request('/public/shares/' + shareToken(link))).status, 404);
    assert.equal(success(await request('/maps', { session: alice })).maps.some(item => item.id === map.id), false);
    assert.equal(success(await request('/maps?trash=1', { session: alice })).maps.some(item => item.id === map.id), true);
    assert.equal(success(await request('/maps?trash=1', { session: bob })).maps.some(item => item.id === map.id), false);
    assert.equal((await request('/maps/' + map.id + '/restore', { method: 'POST', session: bob, body: {} })).status, 404);
    const restored = success(await request('/maps/' + map.id + '/restore', { method: 'POST', session: alice, body: {} })).map;
    assert.equal(restored.deleted_at, null);
    assert.equal(restored.version, map.version + 2);
    assert.equal((await request('/public/shares/' + shareToken(link))).status, 404);
    const newLink = await share(map.id);
    assert.equal((await request('/public/shares/' + shareToken(newLink))).status, 200);
  });

  it('does not reactivate a share created concurrently with moving a map to trash', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const map = await createMap();
      const [shared, deleted] = await Promise.all([
        request('/maps/' + map.id + '/shares', { method: 'POST', session: alice, body: { days: 7 } }),
        request('/maps/' + map.id, { method: 'DELETE', session: alice })
      ]);
      assert.ok([201, 404].includes(shared.status), 'concurrent share is created before deletion or rejected');
      success(deleted);
      success(await request('/maps/' + map.id + '/restore', { method: 'POST', session: alice, body: {} }));
      if (shared.status === 201) assert.equal((await request('/public/shares/' + shareToken(shared.data.share))).status, 404);
    }
  });
  it('duplicates independently and sanitizes executable content before persistence or sharing', async () => {
    const unsafe = emptyMap();
    unsafe.root.data.richText = true;
    unsafe.root.data.text = '<strong>Safe</strong><script>bad()</script>';
    unsafe.root.data.hyperlink = 'javascript:bad()';
    const map = await createMap(alice, { data: unsafe });
    assert.equal(map.data.root.data.text, '<strong>Safe</strong>');
    assert.equal(map.data.root.data.hyperlink, '');
    const copy = success(await request('/maps/' + map.id + '/duplicate', { method: 'POST', session: alice, body: {} }), 201).map;
    assert.notEqual(copy.id, map.id);
    assert.deepEqual(copy.data, map.data);
    success(await request('/maps/' + copy.id, { method: 'PUT', session: alice, body: { version: copy.version, title: 'Independent copy' } }));
    assert.equal(success(await request('/maps/' + map.id, { session: alice })).map.title, map.title);
    const invalid = await request('/maps/' + map.id, { method: 'PUT', session: alice, body: { version: map.version, data: { root: { data: 'broken' } } } });
    assert.equal(invalid.status, 400);
    const link = await share(map.id);
    const publicData = success(await request('/public/shares/' + shareToken(link)));
    assert.doesNotMatch(JSON.stringify(publicData), /javascript:|<script>/);
  });

  it('invalidates other sessions on password change and expires or logs out sessions', async () => {
    const second = await login('bob_test');
    const newPassword = 'new-integration-password-only';
    assert.equal((await request('/auth/password', { method: 'POST', session: bob, body: { currentPassword: 'wrong-password', password: newPassword } })).status, 400);
    success(await request('/auth/password', { method: 'POST', session: bob, body: { currentPassword: password, password: newPassword } }));
    assert.equal((await request('/session', { session: second })).status, 401);
    assert.equal((await request('/session', { session: bob })).status, 200);
    assert.equal((await request('/auth/login', { method: 'POST', body: { username: 'bob_test', password } })).status, 401);
    const replacement = await login('bob_test', newPassword);
    success(await request('/auth/logout', { method: 'POST', session: replacement, body: {} }));
    assert.equal((await request('/session', { session: replacement })).status, 401);
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [bob.user.id]);
    assert.equal((await request('/session', { session: bob })).status, 401);
  });
});
