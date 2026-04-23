import docker from './docker.js';

const ETCD_IMAGE = process.env.ETCD_IMAGE || 'gcr.io/etcd-development/etcd:v3.6.8';
const CONTAINER_NAME = 'core-docker-etcd';

export const bootstrapEtcd = async () => {
  // Check if we are running in the main compose or cluster compose
  if (process.env.NODE_ID) {
    console.log(`[ETCD] Node ${process.env.NODE_ID} skipping individual bootstrap, assuming cluster ETCD is available.`);
    return true;
  }
  try {
    const container = docker.getContainer(CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    console.log('ETCD container is already running.');
    return true;
  } catch (e) {
    if (e.statusCode === 404) {
      console.log('Bootstrapping initial ETCD container...');
      try {
        await docker.getImage(ETCD_IMAGE).inspect();
      } catch (err) {
        console.log(`Pulling ${ETCD_IMAGE}...`);
        await new Promise((resolve, reject) => {
          docker.pull(ETCD_IMAGE, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
          });
        });
      }

      // Determine the network name. If we are in a compose project, it might be prefixed.
      // However, since we defined it with 'name: backhaul' in docker-compose.yml, it should be 'backhaul'.
      // We'll try to find the network first.
      const networks = await docker.listNetworks();
      const targetNetwork = networks.find(n => n.Name === 'backhaul' || n.Name.endsWith('_backhaul'));
      const networkName = targetNetwork ? targetNetwork.Name : 'backhaul';

      console.log(`Using network: ${networkName}`);

      let backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
      
      console.log(`[ETCD] Using host bind mount: ${backupPath}/etcd-data`);

      const etcdConfigPath = `${backupPath}/etcd/config`;

      const createOpts = {
        Image: ETCD_IMAGE,
        name: CONTAINER_NAME,
        Cmd: [
          'etcd',
          '--name', 'node-1',
          '--listen-client-urls', 'http://0.0.0.0:2379',
          '--advertise-client-urls', `http://${CONTAINER_NAME}:2379`,
          '--listen-peer-urls', 'http://0.0.0.0:2380',
          '--initial-advertise-peer-urls', `http://${CONTAINER_NAME}:2380`,
          '--initial-cluster', `node-1=http://${CONTAINER_NAME}:2380`,
          '--initial-cluster-token', 'core-docker-cluster',
          '--initial-cluster-state', 'new',
          '--data-dir', '/etcd-data',
          '--logger', 'zap',
          '--log-outputs', 'stderr',
          '--listen-metrics-urls', 'http://0.0.0.0:2381'
        ],
        HostConfig: {
          User: '0:0',
          RestartPolicy: { Name: 'always' },
          Binds: [
            `${backupPath}/etcd-data:/etcd-data`,
            `${etcdConfigPath}:/etc/etcd:ro`
          ]
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [networkName]: {}
          }
        }
      };

      const newContainer = await docker.createContainer(createOpts);
      await newContainer.start();
      console.log('Initial ETCD container created and start command sent.');
      
      // Verification of container state
      setTimeout(async () => {
          try {
              const check = await newContainer.inspect();
              if (!check.State.Running) {
                  console.error(`[ETCD] Container failed to stay running! ExitCode: ${check.State.ExitCode}, Error: ${check.State.Error}`);
              } else {
                  console.log('[ETCD] Container is verified running.');
              }
          } catch (e) {}
      }, 2000);
      return true;
    } else {
      console.error('Error checking ETCD container:', e);
      return false;
    }
  }
};

export const addEtcdMember = async (nodeName, nodeIp) => {
  try {
    const container = docker.getContainer(CONTAINER_NAME);
    const exec = await container.exec({
      Cmd: ['etcdctl', 'member', 'add', nodeName, '--peer-urls', `http://${nodeIp}:2380`],
      AttachStdout: true,
      AttachStderr: true
    });
    
    return new Promise((resolve, reject) => {
      exec.start(async (err, stream) => {
        if (err) return reject(err);
        
        let output = '';
        stream.on('data', chunk => output += chunk.toString());
        stream.on('end', async () => {
          const inspectData = await exec.inspect();
          if (inspectData.ExitCode === 0) {
            resolve(output);
          } else {
            reject(new Error(`etcdctl member add failed: ${output}`));
          }
        });
      });
    });
  } catch (error) {
    console.error(`Failed to add ETCD member ${nodeName}:`, error);
    throw error;
  }
};
