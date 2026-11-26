import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDefaultInfrastructure } from './lib/infra.mjs';

function main() {
  const args = process.argv.slice(2);
  let devPorts = false;
  for (const argument of args) {
    if (argument === '--dev-ports') {
      devPorts = true;
      continue;
    }
    throw new Error(`Unknown argument ${argument}. Usage: pnpm infra:up [--dev-ports]`);
  }

  const infrastructure = startDefaultInfrastructure({ devPorts });
  console.log(`Default infrastructure is healthy for Compose project ${infrastructure.project}.`);
  if (!devPorts) {
    console.log('No host ports are published. Use pnpm infra:up --dev-ports for explicit loopback development ports.');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
