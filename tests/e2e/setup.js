import { execSync } from 'child_process';

const SKIP_PROVISION = process.env.E2E_SKIP_PROVISION === '1';

export async function setup() {
  if (SKIP_PROVISION) {
    console.log('\n[E2E Setup] Skipping provision (E2E_SKIP_PROVISION=1). Using existing VMs.\n');
    return;
  }

  console.log('\n[E2E Setup] Provisioning 3-node cluster...');
  console.log('  This may take 5-10 minutes on first run (cloud image download).\n');

  const start = Date.now();
  execSync('sudo bash vm/setup-cluster.sh --recreate', {
    stdio: 'inherit',
    cwd: process.cwd(),
    timeout: 900000, // 15 minutes
  });

  const elapsed = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\n[E2E Setup] Cluster provisioned in ${elapsed} minutes.`);
}

export async function teardown() {}
