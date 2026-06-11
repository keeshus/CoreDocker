export function calculateCPU(cpuStats) {
  if (!cpuStats || !cpuStats.cpu_usage || !cpuStats.precpu_usage) return '0.00%';
  const cpuDelta = cpuStats.cpu_usage.total_usage - cpuStats.precpu_usage.total_usage;
  const systemDelta = cpuStats.system_cpu_usage - cpuStats.precpu_usage.system_cpu_usage;
  const onlineCPUs = cpuStats.online_cpus || 1;
  if (systemDelta > 0 && cpuDelta > 0) {
    return ((cpuDelta / systemDelta) * onlineCPUs * 100.0).toFixed(2) + '%';
  }
  return '0.00%';
}

export function calculateMemory(memStats) {
  if (!memStats || !memStats.usage || !memStats.limit) return '0.00%';
  const usage = memStats.usage / 1024 / 1024;
  const limit = memStats.limit / 1024 / 1024;
  return `${usage.toFixed(2)} MB / ${limit.toFixed(2)} MB (${((usage / limit) * 100).toFixed(2)}%)`;
}

export function getExitCodeDescription(code) {
  const descriptions = {
    1: '⚠ 1: Generic error / Application failure',
    126: '✖ 126: Command invoked cannot execute',
    127: '✖ 127: Command not found',
    130: '⏹ 130: Container terminated by Ctrl+C',
    137: '⏹ 137: Container received SIGKILL (e.g. OOM or forced stop)',
    139: '✖ 139: Segmentation fault',
    143: '⏹ 143: Container received SIGTERM (graceful stop)',
  };
  return descriptions[code] || null;
}

export function parseEnvFromInitialData(env) {
  return (env || []).map(e => {
    const secretMatch = e.value?.match(/^\{\{SECRET:(.+)\}\}$/);
    if (secretMatch) {
      return { key: e.key, value: secretMatch[1], isSecret: true };
    }
    return { ...e, isSecret: false };
  });
}

export function buildContainerPayload(formData) {
  const payload = {
    ...formData,
    env: formData.env
      .filter(e => e.key && e.value)
      .map(e => ({
        key: e.key,
        value: e.isSecret ? `{{SECRET:${e.value}}}` : e.value
      })),
    volumes: formData.volumes.filter(v => (v.type !== 'custom' || v.host) && v.container),
    ports: formData.ports.filter(p => p.container).map(p => ({
      ...p,
      host: p.host ? parseInt(p.host, 10) : null,
      container: parseInt(p.container, 10)
    })),
    resources: {
      cpu: formData.resources.cpu ? parseFloat(formData.resources.cpu) : null,
      memory: formData.resources.memory ? parseInt(formData.resources.memory, 10) : null,
    }
  };

  if (payload.proxy.enabled) {
    payload.proxy.port = parseInt(payload.proxy.port, 10);
  }

  // Ensure ha_allowed_nodes is always an array (UI sends array, legacy may send string)
  if (typeof payload.ha_allowed_nodes === 'string') {
    payload.ha_allowed_nodes = parseHaAllowedNodes(payload.ha_allowed_nodes);
  } else if (!Array.isArray(payload.ha_allowed_nodes)) {
    payload.ha_allowed_nodes = [];
  }

  return payload;
}

export function filterContainersByNode(containers, selectedNode) {
  if (!selectedNode) return containers;
  return containers.filter(c => {
    const containerNode = c.current_node || '';
    const nameMatch = c.Names[0].includes(selectedNode.name);
    const isMasterNodeMatch = containerNode === 'master' && selectedNode.name === 'node-1';
    return containerNode === selectedNode.name ||
           containerNode === selectedNode.id ||
           nameMatch ||
           isMasterNodeMatch;
  });
}

export function validatePasswordStrength(password) {
  if (password.length < 12) return { valid: false, error: 'Password must be at least 12 characters long' };
  if (!/[A-Z]/.test(password)) return { valid: false, error: 'Password must include an uppercase letter' };
  if (!/[a-z]/.test(password)) return { valid: false, error: 'Password must include a lowercase letter' };
  if (!/[0-9]/.test(password)) return { valid: false, error: 'Password must include a digit' };
  if (!/[^A-Za-z0-9]/.test(password)) return { valid: false, error: 'Password must include a special character' };
  return { valid: true };
}

export function validatePasswordChange(passwords) {
  if (passwords.next !== passwords.confirm) {
    return { valid: false, error: "New passwords don't match!" };
  }
  return validatePasswordStrength(passwords.next);
}

export function parseHaAllowedNodes(input) {
  return input.split(',').map(s => s.trim()).filter(Boolean);
}
