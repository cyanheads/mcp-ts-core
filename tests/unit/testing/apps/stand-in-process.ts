/**
 * @fileoverview Stand-in executables for the CDP pipe and browser launch tests: a script
 * that speaks CDP on fds 3 and 4, run on the test's own runtime. Never a browser.
 * @module tests/unit/testing/apps/stand-in-process
 */

import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Opens `input` (fd 3) and `output` (fd 4). Node blocks process exit on a threadpool read
 * of a pipe fd, so it reads through a socket; Bun's fd sockets do not read, so it uses
 * streams.
 */
const PIPE_STREAMS = `import fs from 'node:fs';
import net from 'node:net';
const input = typeof Bun === 'undefined'
  ? new net.Socket({ fd: 3, readable: true, writable: false })
  : fs.createReadStream(null, { fd: 3 });
const output = typeof Bun === 'undefined'
  ? new net.Socket({ fd: 4, readable: false, writable: true })
  : fs.createWriteStream(null, { fd: 4 });
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Write `<dir>/<name>`: an executable that runs `body` with `input` and `output` already
 * open. It is a `/bin/sh` wrapper rather than a shebang script because the runtime's path
 * can contain spaces, which a shebang line cannot carry.
 */
export async function writeStandIn(dir: string, name: string, body: string): Promise<string> {
  const script = path.join(dir, `${name}.mjs`);
  const executable = path.join(dir, name);
  await writeFile(script, `${PIPE_STREAMS}${body}`);
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
  );
  await chmod(executable, 0o755);
  return executable;
}
