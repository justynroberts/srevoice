import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { hashPassword } from '../src/auth/password.js';

/**
 * Prints a hash for SREVOICE_PASSWORD_HASH. Reads the password from stdin
 * without echoing it, so it never lands in shell history or the scrollback.
 */
async function readHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (s.startsWith(prompt)) write(s);
  };
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  stdout.write('\n');
  return answer;
}

const first = await readHidden('Password: ');
if (first.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}
const second = await readHidden('Again: ');
if (first !== second) {
  console.error('The two entries did not match.');
  process.exit(1);
}
console.log(`\nSREVOICE_PASSWORD_HASH=${await hashPassword(first)}`);
