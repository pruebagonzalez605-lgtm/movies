import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCommunity, safeReturnUrl, signPayload, verifySignedToken } from '../src/community.js';

const SECRET = 'x'.repeat(48);
const env = {
  SESSION_SECRET: SECRET,
  KICK_CLIENT_ID: 'client-id',
  KICK_CLIENT_SECRET: 'client-secret',
  ALLOWED_SITE_ORIGIN: 'https://colevana.com,http://localhost:5500',
};
const W = 'https://w.example';

// D1 de mentira: guarda lo que se escribe y devuelve resultados fijos.
function fakeDb({ recent = { last_minute: 0, last_day: 0 } } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            run: async () => { writes.push({ sql, args }); return {}; },
            all: async () => ({ results: [{ rating: 5, kick_username: 'alguien' }] }),
            first: async () => recent,
          };
        },
        all: async () => ({ results: [] }),
      };
    },
  };
}

async function session(username = 'streamer', exp = Math.floor(Date.now() / 1000) + 3600) {
  return signPayload({ sub: '1', username, avatar: null, exp }, SECRET);
}

function post(path, body, token, origin = 'https://colevana.com') {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(W + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('signed sessions verify, and tampered, foreign-key or expired ones are rejected', async () => {
  const token = await session();
  assert.equal((await verifySignedToken(token, SECRET)).username, 'streamer');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ username: 'otro', exp: 9999999999 })).toString('base64url');
  assert.equal(await verifySignedToken(`${forged}.${sig}`, SECRET), null);
  assert.equal(await verifySignedToken(`${body}.${sig}x`, SECRET), null);
  assert.equal(await verifySignedToken(token, 'y'.repeat(48)), null);
  assert.equal(await verifySignedToken(await session('a', 10), SECRET), null);
  assert.equal(await verifySignedToken('a.b.c', SECRET), null);
});

test('writing a rating needs a valid session and always uses the signed username', async () => {
  const DB = fakeDb();
  const e = { ...env, DB };
  const noLogin = await handleCommunity(post('/community/ratings', { content_key: 'movie:joker', rating: 5 }), e, new URL(W + '/community/ratings'));
  assert.equal(noLogin.status, 401);
  const token = await session('real_user');
  const res = await handleCommunity(post('/community/ratings', { content_key: 'movie:joker', content_title: 'Joker', rating: 4.5, kick_username: 'victima' }, token), e, new URL(W + '/community/ratings'));
  assert.equal(res.status, 200);
  assert.deepEqual(DB.writes[0].args, ['movie:joker', 'real_user', 'Joker', 4.5]);
  for (const bad of [{ content_key: 'movie:joker', rating: 9 }, { content_key: '../x', rating: 3 }, { content_key: 'movie:joker', rating: 2.25 }, { content_key: 'movie:joker', rating: 0 }]) {
    const r = await handleCommunity(post('/community/ratings', bad, token), e, new URL(W + '/community/ratings'));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const otherSite = await handleCommunity(post('/community/ratings', { content_key: 'movie:joker', rating: 4 }, token, 'https://evil.example'), e, new URL(W + '/community/ratings'));
  assert.equal(otherSite.status, 403);
});

test('suggestions are validated and rate limited per user', async () => {
  const token = await session('real_user');
  const ok = fakeDb();
  const res = await handleCommunity(post('/community/suggestions', { message: '  Suban Dexter  ', kick_username: 'victima' }, token), { ...env, DB: ok }, new URL(W + '/community/suggestions'));
  assert.equal(res.status, 200);
  assert.deepEqual(ok.writes[0].args, ['real_user', 'Suban Dexter']);
  const empty = await handleCommunity(post('/community/suggestions', { message: '   ' }, token), { ...env, DB: ok }, new URL(W + '/community/suggestions'));
  assert.equal(empty.status, 400);
  const tooLong = await handleCommunity(post('/community/suggestions', { message: 'a'.repeat(1001) }, token), { ...env, DB: ok }, new URL(W + '/community/suggestions'));
  assert.equal(tooLong.status, 400);
  const spam = await handleCommunity(post('/community/suggestions', { message: 'otra' }, token), { ...env, DB: fakeDb({ recent: { last_minute: 1, last_day: 1 } }) }, new URL(W + '/community/suggestions'));
  assert.equal(spam.status, 429);
});

test('login only returns to Colevana pages', () => {
  assert.equal(safeReturnUrl('https://colevana.com/player.html?type=movie&id=x#frag', env), 'https://colevana.com/player.html?type=movie&id=x');
  assert.equal(safeReturnUrl('https://evil.example/', env), 'https://colevana.com/');
  assert.equal(safeReturnUrl('javascript:alert(1)', env), 'https://colevana.com/');
});

test('full Kick login: PKCE start, state check and a signed session back to the page', async () => {
  const start = await handleCommunity(new Request(W + '/auth/kick/start?return=' + encodeURIComponent('https://colevana.com/sugerencias.html')), env, new URL(W + '/auth/kick/start?return=' + encodeURIComponent('https://colevana.com/sugerencias.html')));
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('Location'));
  assert.equal(authorize.origin + authorize.pathname, 'https://id.kick.com/oauth/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), W + '/auth/kick/callback');
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  assert.match(start.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const state = authorize.searchParams.get('state');

  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/oauth/token')) return Response.json({ access_token: 'kick-access' });
    return Response.json({ data: [{ user_id: 42, name: 'real_user', profile_picture: 'https://files.kick.com/a.png' }] });
  };
  const callbackUrl = W + `/auth/kick/callback?code=abc&state=${state}`;
  const done = await handleCommunity(new Request(callbackUrl, { headers: { Cookie: cookie } }), env, new URL(callbackUrl), fetcher);
  assert.equal(done.status, 302);
  const back = done.headers.get('Location');
  assert.match(back, /^https:\/\/colevana\.com\/sugerencias\.html#session=/);
  const token = back.split('#session=')[1];
  assert.equal((await verifySignedToken(token, SECRET)).username, 'real_user');
  assert.equal(calls[0].options.body.get('client_secret'), 'client-secret');
  assert.ok(calls[0].options.body.get('code_verifier').length > 40);

  const badState = W + '/auth/kick/callback?code=abc&state=otro';
  const rejected = await handleCommunity(new Request(badState, { headers: { Cookie: cookie } }), env, new URL(badState), fetcher);
  assert.match(rejected.headers.get('Location'), /#error=login_invalid$/);
  const noCookie = await handleCommunity(new Request(callbackUrl), env, new URL(callbackUrl), fetcher);
  assert.match(noCookie.headers.get('Location'), /#error=login_expired$/);
});

test('only admins from ADMIN_USERS can delete suggestions, one or all', async () => {
  const e = { ...env, ADMIN_USERS: 'txc_matheo, otro_admin' };
  const del = async (query, token, DB = fakeDb()) => {
    const req = new Request(W + '/community/suggestions' + query, { method: 'DELETE', headers: { Origin: 'https://colevana.com', Authorization: `Bearer ${token}` } });
    return { res: await handleCommunity(req, { ...e, DB }, new URL(req.url)), DB };
  };
  const admin = await session('TXC_Matheo');
  const user = await session('normal_user');
  assert.equal((await del('?all=1', user)).res.status, 403);
  const one = await del('?id=7', admin);
  assert.equal(one.res.status, 200);
  assert.deepEqual(one.DB.writes[0], { sql: 'DELETE FROM suggestions WHERE id = ?1', args: [7] });
  assert.equal((await del('?id=abc', admin)).res.status, 400);

  // "todas": la consulta no lleva parametros, el DB falso la registra aparte.
  const writes = [];
  const DB = { prepare: (sql) => ({ run: async () => { writes.push(sql); return { meta: { changes: 3 } }; }, bind: () => ({ run: async () => ({}) }) }) };
  const all = await del('?all=1', admin, DB);
  assert.equal(all.res.status, 200);
  assert.deepEqual(writes, ['DELETE FROM suggestions']);
  assert.equal((await all.res.json()).deleted, 3);

  const me = async (token) => {
    const req = new Request(W + '/community/me', { headers: { Authorization: `Bearer ${token}` } });
    return (await handleCommunity(req, { ...e, DB: fakeDb() }, new URL(req.url))).json();
  };
  assert.deepEqual(await me(admin), { username: 'TXC_Matheo', admin: true });
  assert.equal((await me(user)).admin, false);
});
