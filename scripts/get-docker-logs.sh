#!/bin/bash
ssh -i /home/kees/Repositories/core-docker/vm/ssh-keys/cluster.key \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    coredocker@192.168.100.11 \
    'sudo docker logs core-docker-backend --tail 60'
