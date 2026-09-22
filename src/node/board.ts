import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BoardQueue, MultiBoard, type PublicationState, type StateStore, type Publisher } from '../core/board.js';
import { dispatchCollection } from '../core/actions.js';
import { targets, type Config, type Environment } from '../core/config.js';
import { GitHubApp } from '../core/github-app.js';
import { digest } from '../core/signature.js';
import { object, utf8 } from '../core/types.js';

const run = promisify(execFile);
export class FileState implements StateStore {
  constructor(readonly path: string) {}
  async load(): Promise<Partial<PublicationState>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as PublicationState; }
    catch (error) { if (object(error).code === 'ENOENT') return {}; throw error; }
  }
  async save(state: PublicationState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path.replace(/\.json$/, '.tmp'), file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.path);
    const parent = await open(dirname(this.path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
  }
}
export function publisherEnvironment(env: Environment, sourceToken: string, publishToken: string): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE']) if (env[key]) selected[key] = env[key]!;
  return { ...selected, GITHUB_TOKEN: sourceToken, GSB_PUBLISH_TOKEN: publishToken, PYTHONDONTWRITEBYTECODE: '1' };
}
export async function createBoards(cfg: Config): Promise<MultiBoard> {
  const queues: BoardQueue[] = [];
  for (const [source, destination] of Object.entries(targets(cfg))) {
    const identity = (await digest(utf8.encode(source.toLowerCase() + ':' + destination.toLowerCase()))).slice(0, 24);
    const directory = join(cfg.data_dir, 'boards', identity);
    const publish: Publisher = async (generation) => {
      if (cfg.board_execution === 'github_actions') {
        await dispatchCollection(new GitHubApp(cfg.github_app_id, cfg.github_app_private_key), source, destination, generation);
        return { dispatched: true };
      }
      let sourceToken = cfg.board_token, publishToken = cfg.board_token;
      if (cfg.github_app_id) {
        const app = new GitHubApp(cfg.github_app_id, cfg.github_app_private_key);
        sourceToken = await app.tokenFor(source); publishToken = await app.tokenFor(destination, true);
      }
      // The collector belongs to github_status_board. This Node-only adapter is
      // deliberately outside the portable bus and passes no App/webhook secrets.
      const { stdout } = await run('python3', [join(cfg.board_source_dir, 'publish.py'), '--repo', source, '--output', join(directory, 'board-site'), '--publish-repo', destination], {
        env: publisherEnvironment(process.env, sourceToken, publishToken), timeout: 600000, maxBuffer: 1024 * 1024,
      });
      const result = object(JSON.parse(stdout));
      if (!result.ok || typeof result.commit !== 'string' || !/^[0-9a-f]{40}$/.test(result.commit)) throw new TypeError('invalid publisher result');
      return result.commit;
    };
    const stateFile = cfg.board_execution === 'github_actions' ? 'board-dispatch.json' : 'board-publication.json';
    queues.push(await BoardQueue.open(source, destination, new FileState(join(directory, stateFile)), publish, cfg.board_debounce, cfg.board_refresh, undefined, cfg.board_execution));
  }
  return new MultiBoard(queues);
}
