import { execSync } from 'child_process';

export async function setup() {
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
