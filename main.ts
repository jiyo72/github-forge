// Entrypoint. Starts the forge on an ephemeral port, registers that port with
// the trial environment, then long-polls the environment until it signals
// the trial is done. Without MAKEFUN_ENV_URL (a plain local run) it simply
// serves until interrupted, which is how the local conformance runner and a
// real git client can drive it.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
const server = createApp();

await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

if (envUrl === undefined || envUrl === '') {
  console.log(`forge listening on http://127.0.0.1:${port}`);
} else {
  const registered = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registered.ok && registered.status !== 409) {
    console.error(`registration refused: HTTP ${registered.status}`);
    process.exit(1);
  }
  for (;;) {
    let done = false;
    try {
      const answer = await fetch(`${envUrl}/done`);
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        done = payload.done === true;
      }
    } catch {
      done = false;
    }
    if (done) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  server.close();
  process.exit(0);
}
