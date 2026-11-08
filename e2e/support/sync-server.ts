import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface SyncServerOptions {
  readonly port: number;
  /** Where the SQLite file lives. Kept across `stop` and `start`, removed by `dispose`. */
  readonly dataDir: string;
  /** The command that runs the server, program first. */
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  /** Environment variables for the server, on top of this process's. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long `start` waits for `/healthz` to answer. */
  readonly readyTimeoutMs?: number;
  /** How long `stop` waits for the server to exit before killing it. */
  readonly stopTimeoutMs?: number;
}

/** The newest output kept, for the error message when the server does not come up. */
const OUTPUT_LIMIT = 8000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The sync server as a child process that tests can stop, kill and start again on the same
 * database, as a deployment restarts or crashes. The server is the real one (`apps/server`).
 */
export class SyncServer {
  readonly #options: SyncServerOptions;
  #child: ChildProcess | undefined;
  #exited: Promise<void> | undefined;
  #output = '';

  constructor(options: SyncServerOptions) {
    this.#options = options;
  }

  get port(): number {
    return this.#options.port;
  }

  /** Where clients connect. */
  get url(): string {
    return `ws://127.0.0.1:${this.#options.port}/ws`;
  }

  get healthUrl(): string {
    return `http://127.0.0.1:${this.#options.port}/healthz`;
  }

  get databasePath(): string {
    return path.join(this.#options.dataDir, 'driftboard.sqlite');
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  /** What the server has printed lately. */
  get output(): string {
    return this.#output;
  }

  /** Starts the server and resolves once it answers `/healthz`. */
  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error('The server is already running');
    // Another server on the port would answer for the one that is about to fail to start.
    if (await this.#answers()) {
      throw new Error(
        `Something already answers ${this.healthUrl}; is an old server still running?`,
      );
    }
    mkdirSync(this.#options.dataDir, { recursive: true });
    const [program, ...args] = this.#options.command;
    const child = spawn(program, args, {
      cwd: this.#options.cwd,
      env: {
        ...process.env,
        ...this.#options.env,
        DRIFTBOARD_HOST: '127.0.0.1',
        DRIFTBOARD_PORT: String(this.#options.port),
        DRIFTBOARD_DB: this.databasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#output = '';
    const keep = (chunk: Buffer): void => {
      this.#output = (this.#output + chunk.toString()).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    this.#child = child;
    this.#exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        if (this.#child === child) this.#child = undefined;
        resolve();
      });
      child.once('error', (error) => {
        this.#output += `\n${error.message}`;
        if (this.#child === child) this.#child = undefined;
        resolve();
      });
    });
    await this.#waitUntilHealthy(child);
  }

  /** Asks the server to shut down (SIGTERM), and kills it if it has not exited by the timeout. */
  async stop(): Promise<void> {
    await this.#end('SIGTERM', this.#options.stopTimeoutMs ?? 10_000);
  }

  /** Kills the server at once (SIGKILL), as a crash does: nothing is flushed or closed. */
  async kill(): Promise<void> {
    await this.#end('SIGKILL', 10_000);
  }

  /** Stops the server if it runs and removes its database. */
  async dispose(): Promise<void> {
    await this.kill();
    rmSync(this.#options.dataDir, { recursive: true, force: true });
  }

  async #end(signal: 'SIGTERM' | 'SIGKILL', patienceMs: number): Promise<void> {
    const child = this.#child;
    const exited = this.#exited;
    if (child === undefined || exited === undefined) return;
    child.kill(signal);
    let lose: () => void = () => undefined;
    const impatient = new Promise<'timeout'>((resolve) => {
      lose = () => {
        resolve('timeout');
      };
    });
    const timer = setTimeout(lose, patienceMs);
    const outcome = await Promise.race([exited.then(() => 'exited' as const), impatient]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  }

  async #answers(): Promise<boolean> {
    try {
      const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #waitUntilHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (this.#child !== child) {
        throw new Error(`The server exited before it was ready:\n${this.#output}`);
      }
      if (await this.#answers()) return;
      await sleep(100);
    }
    await this.kill();
    throw new Error(`The server did not answer ${this.healthUrl} in time:\n${this.#output}`);
  }
}
