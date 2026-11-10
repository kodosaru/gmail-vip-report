import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.dirname(fileURLToPath(import.meta.url));
const dailyTasks = path.dirname(project);
const workbook = path.join(dailyTasks, 'VIP Email List.xlsx');
const zone = 'America/New_York';
const authFolder = path.join(process.env.LOCALAPPDATA ?? homedir(), 'VipEmailReport');
const credentials = path.join(authFolder, 'credentials.json');
const token = path.join(authFolder, 'token.json');
const python = process.env.VIP_REPORT_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

function runPython(operation, input, ...args) {
  const result = spawnSync(python, [path.join(project, 'format_report.py'), operation, ...args], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Python was not found. Install Python 3.11 or later or set VIP_REPORT_PYTHON to its executable.');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'The Python report step failed.');
  return JSON.parse(result.stdout);
}

// Gmail's per-user quota can take a full minute to clear.
const quotaDelays = [15_000, 30_000, 60_000];

async function retryGmailRequest(request) {
  for (let retry = 0; ; retry++) {
    try {
      return await request();
    } catch (error) {
      const response = error.response;
      const status = response?.status;
      const apiError = response?.data?.error;
      const rateLimited = status === 429 || (status === 403 && (
        apiError?.errors?.some(({ reason }) => reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
        || apiError?.details?.some(({ reason }) => reason === 'RATE_LIMIT_EXCEEDED')
        || /quota exceeded.*units per minute/i.test(apiError?.message ?? error.message)
      ));
      if (!rateLimited || retry === quotaDelays.length) throw error;

      const retryAfter = response?.headers?.get?.('retry-after') ?? response?.headers?.['retry-after'];
      const serverDelay = /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - Date.now();
      if (serverDelay > 120_000) throw error;
      const delay = Math.max(quotaDelays[retry], serverDelay || 0) + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function connect(reset, mailbox) {
  const { google } = await import('googleapis');
  const { authorizeInBrowser } = await import('./oauth.mjs');
  let desktop;
  try {
    desktop = JSON.parse(await readFile(credentials, 'utf8')).installed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Save your Google Desktop OAuth client JSON at ${credentials}. See README.md.`);
  }
  if (!desktop?.client_id || !desktop.client_secret) {
    throw new Error('credentials.json must contain a Google Desktop app OAuth client ID and secret.');
  }

  const auth = new google.auth.OAuth2(desktop.client_id, desktop.client_secret);
  let saved;
  if (!reset) {
    try {
      saved = JSON.parse(await readFile(token, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (saved && (saved.client_id !== desktop.client_id || !saved.refresh_token)) {
    throw new Error('The saved sign-in does not match this OAuth client. Run npm.cmd run report -- --reauthorize.');
  }

  const tokens = saved ? { refresh_token: saved.refresh_token } : await authorizeInBrowser(auth, mailbox);
  auth.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth });
  const { data } = await retryGmailRequest(() => gmail.users.getProfile({ userId: 'me' }));
  if (data.emailAddress?.toLowerCase() !== mailbox) {
    throw new Error(`Sign in as ${mailbox}. To select a different account, run npm.cmd run report -- --reauthorize.`);
  }
  if (!saved && tokens.refresh_token) {
    await mkdir(authFolder, { recursive: true });
    await writeFile(token, JSON.stringify({
      client_id: desktop.client_id,
      refresh_token: tokens.refresh_token,
    }), { encoding: 'utf8', mode: 0o600 });
  }
  return gmail;
}

async function listInbox(messages, start, end) {
  const ids = new Set();
  const seen = new Set();
  const q = `after:${Math.floor(start / 1000) - 1} before:${Math.floor(end / 1000) + 1}`;
  let pageToken;
  do {
    const { data } = await retryGmailRequest(() => messages.list({
      userId: 'me', labelIds: ['INBOX'], q, maxResults: 500, pageToken,
    }));
    for (const message of data.messages ?? []) ids.add(message.id);
    pageToken = data.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error('Gmail repeated a page token.');
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return [...ids];
}

// Limit simultaneous Gmail requests while preserving the order of results.
async function mapInBatches(items, getItem) {
  const result = [];
  for (let start = 0; start < items.length; start += 8) {
    result.push(...await Promise.all(items.slice(start, start + 8).map(getItem)));
  }
  return result;
}

const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function easternParts(timestamp) {
  return Object.fromEntries(clock.formatToParts(timestamp).map(({ type, value }) => [type, value]));
}

export async function buildReport(gmail, { end, workbookPath = workbook, outputFolder = dailyTasks }) {
  const start = end - 7 * 24 * 60 * 60 * 1000;
  const messages = gmail.users.messages;
  const ids = await listInbox(messages, start, end);
  const headers = await mapInBatches(ids, async id => {
    const { data } = await retryGmailRequest(() => messages.get({
      userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'],
    }));
    if (data.id !== id || !data.internalDate || !data.payload?.headers) {
      throw new Error(`Gmail returned incomplete metadata for message ${id}.`);
    }
    return { ...data, labelIds: data.labelIds ?? [] };
  });
  const selected = runPython('select', { start, end, headers }, workbookPath);
  const entries = await mapInBatches(selected, async entry => {
    const { data } = await retryGmailRequest(() => messages.get({ userId: 'me', id: entry.id, format: 'raw' }));
    if (data.id !== entry.id || !data.raw) throw new Error(`Gmail returned an incomplete message for ${entry.id}.`);
    const { year, month, day, hour, minute } = easternParts(entry.received);
    return { ...entry, raw: data.raw, date: `${year}-${month}-${day} ${hour}:${minute} ET` };
  });
  const { year, month, day, weekday } = easternParts(end);
  const output = path.join(outputFolder, `VIP_Email_${year}${month}${day}_${weekday}.txt`);
  return runPython('write', entries, output);
}

async function main() {
  const end = Date.now();
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--reauthorize')) throw new Error('Usage: npm.cmd run report [-- --reauthorize]');
  // Check the workbook and Python before opening the Google sign-in page.
  const { mailbox } = runPython('check', { settingsPath: path.join(project, 'settings.xml') }, workbook);
  const gmail = await connect(args.includes('--reauthorize'), mailbox);
  const { count, output } = await buildReport(gmail, { end });
  console.log(`Saved ${count} matching emails to ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const expired = error.response?.data?.error === 'invalid_grant' || /invalid_grant/i.test(error.message);
    console.error(expired
      ? 'Google authorization expired. Run npm.cmd run report -- --reauthorize.'
      : error.message);
    process.exitCode = 1;
  });
}
