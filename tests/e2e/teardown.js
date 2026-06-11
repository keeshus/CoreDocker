import { execSync } from 'child_process';

const SKIP_TEARDOWN = process.env.E2E_SKIP_TEARDOWN === '1' || process.env.E2E_SKIP_PROVISION === '1';

export async function teardown() {
  if (SKIP_TEARDOWN) {
    console.log('\n[E2E Teardown] Skipping teardown (VMs left running).\n');
    return;
  }

  console.log('\n[E2E Teardown] Destroying cluster...');
  try {
    execSync('sudo bash vm/destroy-cluster.sh', {
      stdio: 'inherit',
      cwd: process.cwd(),
      timeout: 60000,
    });
    console.log('[E2E Teardown] Cluster destroyed.\n');
  } catch (e) {
    console.error('[E2E Teardown] Cleanup failed:', e.message);
  }
}
