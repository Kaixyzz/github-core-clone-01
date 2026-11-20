// The process spends its whole life doing one job: bring the forge up on a
// port the kernel picks, hand that port to the trial environment, then stay
// alive until the environment reports the trial is finished.
//
// The conversation with the environment is only two calls:
//   POST {env}/register  with {"port": N}   -> the env starts dialing the forge
//   GET  {env}/done                         -> {"done": false} while the suite
//                                              is still running, {"done": true}
//                                              when it has written its export
// Neither call is allowed to kill the process by failing once: the env may
// still be booting, so a failed attempt just waits a little and tries again.
// Only a 400/405 from register is a real contract error and ends the run.

import { createApp } from './app.ts';

// Where the trial environment listens. Trailing slashes are trimmed so the
// paths below always join cleanly. Without it there is nobody to talk to.
const ENV = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is missing, nothing to register with\n');
  process.exit(1);
}

// One request gets thirty seconds before it is given up on and retried.
const REQUEST_BUDGET_MS = 30_000;
// Retries wait longer after every failure: a fifth of a second at first,
// doubling each time, never more than two seconds.
const PAUSE_START_MS = 200;
const PAUSE_LIMIT_MS = 2_000;

const rest = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function pauseFor(failures: number): number {
  return Math.min(PAUSE_LIMIT_MS, PAUSE_START_MS * 2 ** Math.min(failures, 8));
}

// Tell the environment which port the forge bound. A 200 means it heard us;
// a 409 means some entry already registered first, which is fine too — the
// forge still waits like any other. 400/405 mean the request itself is wrong
// and no retry will fix it, so those throw. Anything else — a refused
// connection, a timeout, an unexpected status — just waits and tries again.
async function tellEnv(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${ENV}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused with HTTP ')) throw err;
    }
    await rest(pauseFor(failures));
  }
}

// Ask the environment whether the trial is over, until it says it is. A
// reply that is not ok, a body that is not JSON, or a request that fails
// outright all mean the same thing — not done yet — so the loop just waits
// and asks again. This function only returns on {"done": true}.
async function waitForFinish(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${ENV}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering, or the request timed out: still
      // running, so keep polling.
    }
    await rest(pauseFor(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  process.stdout.write(`[forge] up on port ${bound.port}\n`);

  await tellEnv(bound.port);
  process.stdout.write('[forge] registered, waiting for the trial to finish\n');

  await waitForFinish();
  server.close();
  process.stdout.write('[forge] trial finished\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
