# Architectural Plan: ETCD-Driven DNS-Based High Availability

This document outlines the design for a scalable, container-level High Availability (HA) system using ETCD for cluster orchestration and CoreDNS for dynamic service discovery.

## 1. Core Architecture Pattern

The system move away from wide-spread host-level VIP failover for all applications. Instead, it uses **DNS-Based Service Discovery Failover**. 

*   **Workloads** are dynamically rescheduled by ETCD based on host health.
*   **DNS records** are updated in real-time to point to the new location of the workload.
*   **Keepalived** is relegated to a single specialized task: maintaining a highly available **DNS entry point**.

---

## 2. Infrastructure Components

### 2.1 CoreDNS (Dynamic Resolver)
- **Deployment:** Runs as a "Daemon Container" on every node in the cluster.
- **Backend:** Uses the `etcd` plugin to read DNS records directly from the shared ETCD cluster.
- **The DNS VIP:** A single Virtual IP (VIP) is maintained via Keepalived (on a subset of 2-3 nodes). This VIP (e.g., `192.168.1.53`) is the **only** IP configured in the home router's DNS settings. It ensures DNS queries always reach an active CoreDNS instance, regardless of which node is master.

### 2.2 ETCD (Cluster Brain)
- **State Storage:** Stores all container configurations, current assignments, and node health status.
- **Native Heartbeats:** Nodes use ETCD **Leases** (TTL-based keys) to maintain a "liveness" signal.
- **Leader Election:** The cluster elects a single **Scheduler Leader** using ETCD's native distributed locking/election API.

---

## 3. Implementation Phases

### Phase 1: Node Health & Election logic
1.  **Heartbeat Mechanism:** Nodes register themselves at `/nodes/{id}` with an ETCD Lease. If the node dies, the key vanishes automatically.
2.  **Leader Election:** Nodes compete to become the `cluster-scheduler` leader. Only the winner runs the scheduling and DNS update logic.

### Phase 2: Enhanced Scheduling Data
1.  **UI Updates:** Modify `CreateContainer.js` to include `ha_enabled` and `ha_allowed_nodes`.
2.  **Schema Updates:** Containers in ETCD now track their `current_node` and resource requirements.

### Phase 3: The Scheduler Logic (Leader Only)
1.  **Detection:** Monitors `/nodes/` for expirations.
2.  **Reassignment:** Orphans are moved to surviving nodes with the most available resources.
3.  **DNS Update:** The Leader updates the ETCD DNS key (e.g., `/skydns/local/home/myapp`) to point to the new host node's IP.

### Phase 4: The Local Reconciler (Every Node)
1.  **State Observation:** Each node ensures the containers assigned to it in ETCD are running locally.
2.  **Proxy Update:** Updates local NGINX config to route traffic for the new containers based on the assigned ports/domains.

---

## 4. Disaster Recovery Walkthrough

1.  **Failure:** Node A (running `plex.local`) loses power.
2.  **Detection:** Node A's ETCD Lease expires.
3.  **Rescheduling:** The Scheduler Leader (Node B) picks Node C as the new home for Plex and updates ETCD.
4.  **DNS Update:** Node B updates ETCD so `plex.local` now points to Node C's IP.
5.  **Takeover:** Node C's reconciler starts the Plex container.
6.  **Resolution:** Client DNS queries hit the **DNS VIP** (managed by Keepalived). CoreDNS answers with Node C's IP. Traffic flows to the new host.

---

## 5. Why This Scales
This setup scales to any number of nodes because:
1.  **Router Config stays static:** You only ever need one DNS IP in your router.
2.  **No ARP Flood:** Only one IP (the DNS VIP) needs to be managed via Keepalived/ARP. All other failover happens at the software (DNS) layer.
3.  **Node Independence:** Any node can host any container without needing to "own" a specific IP address.
