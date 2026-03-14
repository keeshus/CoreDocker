import docker from './docker.js';
import { getNodes } from './db.js';

const ETCD_IMAGE = process.env.ETCD_IMAGE || 'quay.io/coreos/etcd:latest';
const CONTAINER_NAME = 'core-docker-etcd';

export const bootstrapEtcd = async () => {
  try {
    const container = docker.getContainer(CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    console.log('ETCD container is already running.');
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

      const createOpts = {
        Image: ETCD_IMAGE,
        name: CONTAINER_NAME,
        Cmd: [
          'etcd',
          '--name', 'node-1',
          '--listen-client-urls', 'http://0.0.0.0:2379',
          '--advertise-client-urls', 'http://127.0.0.1:2379',
          '--listen-peer-urls', 'http://0.0.0.0:2380',
          '--initial-advertise-peer-urls', 'http://127.0.0.1:2380',
          '--initial-cluster', 'node-1=http://127.0.0.1:2380',
          '--initial-cluster-token', 'core-docker-cluster',
          '--initial-cluster-state', 'new'
        ],
        HostConfig: {
          NetworkMode: 'host',
          RestartPolicy: { Name: 'always' }
        }
      };

      const newContainer = await docker.createContainer(createOpts);
      await newContainer.start();
      console.log('Initial ETCD container bootstrapped successfully.');
    } else {
      console.error('Error checking ETCD container:', e);
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
