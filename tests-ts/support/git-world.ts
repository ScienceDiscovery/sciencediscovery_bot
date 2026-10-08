import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { basicAuthorization } from '../../src/core/git-http.js';

/**
 * Two local bare repositories behind git's own smart-HTTP CGI stand in for
 * GitHub (upload-pack, protocol v2) and GitCode (receive-pack). The histories
 * diverge after a common commit, as the real hosts do. Credentials are fixtures.
 */
export const GIT_FIXTURE = { githubToken: 'ghs_LOCALFIXTURETOKEN0123456789abcdefgh', gitcodeToken: 'gitcode-local-fixture-token-0123456789', gitcodeUser: 'sync-bot' };
export async function gitWorld(t: { after: (fn: () => Promise<void>) => void }, options: { githubToken?: string; source?: string; target?: string } = {}) {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests-ts/git-world-'));
  const sourceRepo = options.source || 'openJiuwen-ai/sciencediscovery', targetRepo = options.target || 'openJiuwen/sciencediscovery';
  const auth = { github: basicAuthorization('x-access-token', options.githubToken || GIT_FIXTURE.githubToken), gitcode: basicAuthorization(GIT_FIXTURE.gitcodeUser, GIT_FIXTURE.gitcodeToken) };
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const github = join(root, 'github', sourceRepo + '.git'), gitcode = join(root, 'gitcode', targetRepo + '.git'), work = join(root, 'work');
  for (const dir of [github, gitcode, work]) await mkdir(dir, { recursive: true });
  git(github, 'init', '-q', '--bare', '-b', 'main'); git(gitcode, 'init', '-q', '--bare', '-b', 'main');
  git(gitcode, 'config', 'http.receivepack', 'true');
  git(work, 'init', '-q', '-b', 'main');
  const commit = async (name: string): Promise<string> => { await writeFile(join(work, name + '.txt'), name + '\n'.repeat(3)); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', name); return git(work, 'rev-parse', 'HEAD'); };
  const common = await commit('common');
  git(work, 'push', '-q', github, 'main'); git(work, 'push', '-q', gitcode, 'main');
  const githubOnly = await commit('github-only'); git(work, 'push', '-q', github, 'main');
  git(work, 'checkout', '-q', '-b', 'gitcode-main', common);
  const gitcodeOnly = await commit('gitcode-only'); git(work, 'push', '-q', gitcode, 'HEAD:refs/heads/main');
  git(work, 'checkout', '-q', '-b', 'pr', githubOnly);
  const head = await commit('pull-request'); git(work, 'push', '-q', github, 'HEAD:refs/pull/1/head');

  const requests: { host: string; method: string; path: string; protocol: string }[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1'), [, host] = url.pathname.split('/');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push({ host, method: req.method || '', path: url.pathname, protocol: String(req.headers['git-protocol'] || '') });
    if (!['github', 'gitcode'].includes(host)) { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== auth[host as 'github' | 'gitcode']) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end('denied'); return; }
    const body = Buffer.concat(chunks);
    const cgi = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: join(root, host), GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname.slice(host.length + 1),
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: String(req.headers['content-type'] || ''), CONTENT_LENGTH: String(body.length),
      GIT_PROTOCOL: String(req.headers['git-protocol'] || ''), REMOTE_USER: 'fixture', REMOTE_ADDR: '127.0.0.1' } });
    const out: Buffer[] = []; cgi.stdout.on('data', c => out.push(c)); cgi.stderr.resume();
    // The CGI may exit before reading the whole body (e.g. upload-pack rejecting an unknown want);
    // its output is still the response, so a broken stdin pipe is expected, not a test failure.
    cgi.stdin.on('error', () => undefined);
    cgi.stdin.end(body);
    await new Promise(done => cgi.on('close', done));
    const raw = Buffer.concat(out), split = raw.indexOf('\r\n\r\n');
    const headers: Record<string, string> = {}; let status = 200;
    for (const line of raw.subarray(0, split).toString().split('\r\n')) {
      const [name, ...rest] = line.split(':'); const value = rest.join(':').trim();
      if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else if (name) headers[name] = value;
    }
    res.writeHead(status, headers).end(raw.subarray(split + 4));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  t.after(async () => { await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const source = { url: `${base}/github/${sourceRepo}.git`, authorization: auth.github };
  const target = { url: `${base}/gitcode/${targetRepo}.git`, authorization: auth.gitcode };
  return { git, github, gitcode, work, commit, source, target, requests, base, ids: { common, githubOnly, gitcodeOnly, head } };
}
