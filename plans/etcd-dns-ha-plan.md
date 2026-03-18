# Architectural Plan: ETCD-Driven DNS-Based High Availability

This document outlines the design for a scalable, container-level High Availability (HA) system using ETCD for cluster orchestration and CoreDNS for dynamic service discovery.

## 1. Core Architecture Pattern

The system moves away from host-level VIP failover (Keepalived) and instead uses **Service Discovery Failover**. Workloads are dynamically rescheduled based on host health, and DNS records are updated in real-time to point to the new location of the workload.

---

## 2. Infrastructure Components

### 2.1 CoreDNS (Dynamic Resolver)
- **Deployment:** Runs as a "Daemon Container" on every node in the cluster.
- **Backend:** Uses the `etcd` plugin to read DNS records directly from the shared ETCD cluster.
- **Failover:** A single Virtual IP (VIP) is maintained via a minimal Keepalived setup (on only 2-3 nodes) to provide a static entry point for the home router.

### 2.2 ETCD (Cluster Brain)
- **State Storage:** Stores all container configurations, current assignments, and node health status.
- **Heartbeats:** Nodes use ETCD **Leases** (TTL-based keys) to maintain a "liveness" signal.
- **Leader Election:** The cluster elects a single **Scheduler Leader** using ETCD's distributed locking/election API.

---

## 3. Implementation Phases

### Phase 1: Node Health & Election logic
1.  **Heartbeat Mechanism:**
    - Update [`backend/services/db.js`](backend/services/db.js) to use native ETCD Leases.
    - Nodes register themselves at `/nodes/{id}` with a 10s Lease.
2.  **Leader Election:**
    - Implement a election loop where nodes compete to become the `cluster-scheduler` leader.
    - Only the Leader node activates its scheduling logic.

### Phase 2: Enhanced Scheduling Data
1.  **UI Updates:**
    - Modify `CreateContainer.js` to include HA settings:
        - `ha_enabled` (toggle).
        - `ha_allowed_nodes` (multi-select of active nodes).
2.  **Schema Updates:**
    - Update the ETCD container record to include `current_node` and resource requirements (CPU/RAM).

### Phase 3: The Scheduler Logic (Leader Only)
1.  **Node Death Detection:** Watches the `/nodes/` prefix for key expiration events.
2.  **Reassignment Algorithm:**
    - Identify orphaned containers where `current_node == dead_node`.
    - Filter surviving nodes based on `ha_allowed_nodes`.
    - Select the candidate node with the **most available resources** (lowest current utilization).
    - Update the container's `current_node` in ETCD.
3.  **DNS Synchronization:**
    - Update the CoreDNS record in ETCD (`/skydns/...`) to point the application's domain to the new host node's IP.

### Phase 4: The Local Reconciler (Every Node)
1.  **State Observation:** Watches ETCD for containers assigned to its own `node_id`.
2.  **Workload Management:**
    - If a container is assigned but not running: **Pull & Start**.
    - If a container is running but assigned elsewhere: **Stop & Remove**.
3.  **Proxy Update:** Updates the local NGINX config to route traffic for the new containers.

---

## 4. Disaster Recovery Walkthrough

1.  **Stable State:** Node A runs `plex.local`. DNS resolves `plex.local` -> `Node A IP`.
2.  **Failure:** Node A loses power.
3.  **Expiration:** Node A's ETCD Lease expires (after 10s).
4.  **Rescheduling:** The Scheduler Leader (Node B) detects the death, picks Node C as the best host, and updates ETCD.
5.  **DNS Update:** Node B updates the DNS record in ETCD: `plex.local` -> `Node C IP`.
6.  **Startup:** Node C's reconciler sees the new assignment, starts the Plex container, and reloads NGINX.
7.  **Resolution:** Client queries for `plex.local` hit CoreDNS, which returns `Node C IP`. Traffic flows to the new host.

---

## 5. Scalability Benefits
- **Infinite Nodes:** New nodes can join the cluster and immediately begin taking over HA workloads without manual DNS or IP configuration.
- **Any Network:** Works across different subnets since it relies on DNS resolution rather than Layer 2 ARP broadcasts.
- **Resource Efficient:** Workloads are distributed based on actual host load rather than simple round-robin.
