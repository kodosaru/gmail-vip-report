import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { google } from 'googleapis';
import { authorizeInBrowser } from './oauth.mjs';

const mailbox = 'reader@example.com';

test('desktop sign-in rejects the wrong state and exchanges the code with its PKCE verifier', { timeout: 10_000 }, async t => {
  const requests = [];
  const tokenServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    requests.push(form);
    const body = form.get('grant_type') === 'refresh_token'
      ? { access_token: 'test-refreshed', expires_in: 3600, token_type: 'Bearer' }
      : { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, token_type: 'Bearer' };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  tokenServer.listen(0, '127.0.0.1');
  await once(tokenServer, 'listening');
  t.after(() => tokenServer.close());
  const client = new google.auth.OAuth2({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    endpoints: { oauth2TokenUrl: `http://127.0.0.1:${tokenServer.address().port}/token` },
  });

  let challenge;
  let redirect;
  const tokens = await authorizeInBrowser(client, mailbox, async url => {
    const params = new URL(url).searchParams;
    const state = params.get('state');
    redirect = new URL(params.get('redirect_uri'));
    challenge = params.get('code_challenge');
    assert.equal(redirect.hostname, '127.0.0.1');
    assert.equal(params.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(params.get('access_type'), 'offline');
    assert.equal(params.get('login_hint'), mailbox);
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.ok(state.length >= 32);
    assert.equal((await fetch(new URL('?state=wrong&code=forged', redirect))).status, 400);
    assert.equal(requests.length, 0);
    const callback = new URL(redirect);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', 'test-code');
    assert.equal((await fetch(callback)).status, 200);
  });

  assert.equal(tokens.refresh_token, 'test-refresh');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.get('grant_type'), 'authorization_code');
  assert.equal(request.get('code'), 'test-code');
  assert.equal(request.get('redirect_uri'), redirect.origin);
  assert.equal(createHash('sha256').update(request.get('code_verifier')).digest('base64url'), challenge);

  client.setCredentials({ refresh_token: tokens.refresh_token });
  assert.equal((await client.getAccessToken()).token, 'test-refreshed');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get('grant_type'), 'refresh_token');
  assert.equal(requests[1].get('refresh_token'), 'test-refresh');
});

test('a declined sign-in never reaches token exchange', { timeout: 10_000 }, async () => {
  const client = new google.auth.OAuth2('test-client', 'test-secret');
  client.getToken = () => assert.fail('Declined sign-in attempted a token exchange.');
  await assert.rejects(authorizeInBrowser(client, mailbox, async url => {
    const params = new URL(url).searchParams;
    const callback = new URL(params.get('redirect_uri'));
    callback.searchParams.set('state', params.get('state'));
    callback.searchParams.set('error', 'access_denied');
    assert.equal((await fetch(callback)).status, 400);
  }), /declined/);
});
