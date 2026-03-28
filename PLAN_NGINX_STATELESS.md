# Architectural Plan: Stateless Backend, Ephemeral Containers, and High Availability

## Objective
Modify `core-docker` to decouple the backend from a static `/data/backup` volume mount using ephemeral native containers, creating a truly stateless orchestrator. Expand High Availability (HA) features to Container Groups, implement robust automated syncs, and introduce a generic concurrency and logging system for all background jobs (both node-specific and cluster-wide) with built-in retention policies.

## Scope of Changes

### 1. Direct Frontend-Backend Connection
*   **Current State:** The frontend and backend may rely on specific proxy rules or external access.
*   **New State:** The frontend will communicate directly with the backend on port `3000` via the internal Docker network (`backhaul`).

### 2. Stateless Backend
*   **Implementation:** Remove the `/data/backup:/data/backup` line from the `backend` service definition in `docker-compose.yml`.

### 3. Dynamic Nginx Initialization
*   **Implementation:** Remove the static `nginx` service. Create a bootstrapping routine in `backend/services/nginx.js` that dynamically spawns the proxy container with the user-configured `backupPath` mounted dynamically.

### 4. Ephemeral Native Containers (Filesystem & Scheduler)
*   **Implementation:**
    *   **Nginx Configuration:** Spawns a temporary `alpine` container mounting `<backupPath>` to execute shell scripts that write `.conf` and certificates, then destroys it immediately.
    *   **Scheduler Tasks:** Spawns required official ephemeral containers (e.g., `restic/restic`, `certbot/certbot`) to run jobs and destroy them.

### 5. High Availability Container Groups (Frontend & Backend)
*   **Implementation:**
    *   Update UI to include HA toggles and "Target Nodes" multi-select at the Group level.
    *   Hide/disable individual container HA settings if assigned to an HA-enabled Group.
    *   Update backend logic in `routes/groups.js` and `routes/containers.js` to enforce Group HA inheritance.

### 6. Generic Scheduler Concurrency Locks (Node vs Cluster)
*   **Implementation:**
    *   Create a generic locking wrapper in `scheduler.js`: `withLock(taskName, scope, callback)`. 
    *   **Node-Specific Scope:** For tasks that must run on every node's local disk (e.g., `restic` backup, `certbot` renewal, `ha-folder-sync`), the lock is specific to the node (e.g., `locks/restic/node-1`). This prevents overlapping backups *on the same node*, but allows Node A and Node B to backup simultaneously.
    *   **Cluster-Wide Scope:** For tasks that should only happen once across the entire cluster (e.g., purging old ETCD log entries, reconciling global cluster state), the lock is global (e.g., `locks/log-purge/global`). The first node to acquire the ETCD lock executes the task; other nodes skip it.

### 7. Generic System Logging & Retention Service (Batched to BackupPath)
*   **New State:** A centralized logging service that stores event data and task outputs directly to the user-configured `backupPath` (avoiding ETCD bloat). It features configurable retention periods and manual purging.
*   **Implementation:**
    *   Create `backend/services/logger.js`.
    *   **Batching Logic:** Because the backend is stateless and doesn't mount `backupPath`, the logger caches new log entries in-memory. Every 5 minutes, it flushes the batch by spawning a single ephemeral `alpine` container to append the entries into a structured `system-logs.jsonl` file inside the `backupPath`. This avoids bashing ETCD while drastically reducing container spawns. The logger must also hook into the process `SIGTERM`/`SIGINT` handlers in `index.js` to perform a final flush during backend shutdown, ensuring zero log loss.
    *   Add a daily cluster-wide scheduled job: `purge-old-logs`, which automatically parses the JSONL file and deletes entries exceeding the configured retention time.
    *   Add a UI view (e.g., "System Logs") with a "Purge Now" button and a retention configuration dropdown.
    *   **App Integration Points:**
        *   **Scheduler Tasks:** Outputs (`stdout`/`stderr`) from all ephemeral containers (HA syncs, restic, certbot).
        *   **Audit/System Events:** User logins, container creation/deletion, system initialization, and master password changes.
        *   **Orchestrator/Reconciler:** Node failures, container migrations, and automated restart events triggered by the orchestrator.
        *   **Nginx Router:** Route additions/removals and SSL cert issuance events.

### 8. 5-Minute High Availability Sync
*   **Implementation:** Add a node-specific `ha-folder-sync` job running every 5 minutes. Wrapped in a node-scoped Generic Lock, it uses an ephemeral `rsync` container to securely sync local HA folders to target nodes over the `backhaul` high-speed network, capturing all output to the Generic Logging Service.

## Execution Order
1.  **Compose Updates:** Remove static volumes and `nginx` from `docker-compose.yml`.
2.  **Generic Logging & Scoped Locks:** Implement `services/logger.js` (with batched filesystem flushing) and ETCD-based Node/Cluster scoped mutex locks in `scheduler.js`.
3.  **Ephemeral Task Service:** Create `services/ephemeral-tasks.js` to handle dynamic container execution and pipe outputs to the generic logger.
4.  **Refactor Nginx/Filesystem:** Migrate `fs` operations to ephemeral alpine containers.
5.  **Refactor Scheduler Jobs:** Migrate `restic`, `certbot`, and future tasks to use the scoped lock (Node-level), ephemeral task service, and generic logger.
6.  **HA Group Logic:** Update Backend and Frontend to support HA inheritance for Container Groups.
7.  **HA Sync Task:** Implement the node-scoped `ha-folder-sync` securely over `backhaul`.
