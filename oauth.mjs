import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import open from 'open';

const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const loopbackHost = '127.0.0.1';

// Google redirects the browser here. State binds the response to this sign-in,
// and the PKCE verifier binds the code exchange to this process.
export async function authorizeInBrowser(auth, mailbox, openBrowser = open) {
  const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
  const state = randomBytes(32).toString('base64url');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopbackHost, resolve);
  });

  const redirectUri = `http://${loopbackHost}:${server.address().port}`;
  let code;
  let timer;
  try {
    const authorizationUrl = auth.generateAuthUrl({
      redirect_uri: redirectUri,
      scope,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: mailbox,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Google sign-in timed out. Run the report again.')), 180_000);
      server.once('error', reject);
      server.on('request', (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Connection', 'close');
        if (request.method !== 'GET' || !request.url?.startsWith('/?')) {
          response.writeHead(404).end('Sign-in callback not found.');
          return;
        }
        const params = new URLSearchParams(request.url.slice(2));
        if (params.get('state') !== state) {
          response.writeHead(400).end('This response does not match the active sign-in.');
          return;
        }
        if (params.has('error') || !params.get('code')) {
          response.writeHead(400).end('Google sign-in was declined or did not return a code.');
          reject(new Error('Google sign-in was declined or did not return a code.'));
          return;
        }
        response.end('Sign-in response received. You can close this tab and return to VS Code.');
        resolve(params.get('code'));
      });
      Promise.resolve().then(() => openBrowser(authorizationUrl)).catch(reject);
    });
  } finally {
    clearTimeout(timer);
    server.close();
  }

  const { tokens } = await auth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  return tokens;
}
