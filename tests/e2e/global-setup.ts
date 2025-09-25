import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function globalSetup(): Promise<void> {
  const root = path.resolve(__dirname, '../../');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

export default globalSetup;
