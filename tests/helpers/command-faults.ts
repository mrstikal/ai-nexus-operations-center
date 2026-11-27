import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';

export async function crashAfterWritingFile(
  path: string,
  content: string,
): Promise<NodeJS.Signals | null> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('fs');fs.writeFileSync(process.argv[1],process.argv[2]);process.kill(process.pid,'SIGKILL')",
        path,
        content,
      ],
      { stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('exit', (_code, signal) => {
      if (signal === null) {
        reject(new Error('child did not die by signal'));
      } else {
        resolve();
      }
    });
  });
  return 'SIGKILL';
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing file is already clean.
  }
}
