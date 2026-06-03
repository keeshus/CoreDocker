import React, { useState, useEffect, useRef } from 'react';

export default function TasksTab() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedTask, setExpandedTask] = useState(null);
  const expandedRef = useRef(null);
  const [taskLogs, setTaskLogs] = useState({});
  const [loadingLogs, setLoadingLogs] = useState({});
  const [logContent, setLogContent] = useState({});
  const [loadingContent, setLoadingContent] = useState({});
  const [nodes, setNodes] = useState([]);
  const [selectedNode, setSelectedNode] = useState('');
  const selectedNodeRef = useRef('');
  // Keep ref in sync with state so intervals always read the latest value
  useEffect(() => { selectedNodeRef.current = selectedNode; }, [selectedNode]);
  const [loadingNodes, setLoadingNodes] = useState(true);

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();

    fetch('/api/nodes')
      .then(res => res.json())
      .then(data => {
        setNodes(data);
        if (data.length > 0 && !selectedNode) {
          setSelectedNode(data[0].id);
        }
        setLoadingNodes(false);
      })
      .catch(() => setLoadingNodes(false));

    const taskInterval = setInterval(fetchTasks, 5000);
    // Also auto-refresh expanded task logs every 10s
    const logInterval = setInterval(() => {
      if (expandedRef.current) {
        loadTaskLogs(expandedRef.current, true);
      }
    }, 10000);

    return () => {
      clearInterval(taskInterval);
      clearInterval(logInterval);
    };
  }, []);

  const toggleTask = async (taskId, enabled) => {
    try {
      await fetch(`/api/tasks/${taskId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      fetchTasks();
    } catch (e) {
      console.error('Failed to toggle task:', e);
    }
  };

  const [triggerCooldown, setTriggerCooldown] = useState({});

  const triggerTask = async (taskId) => {
    setTriggerCooldown(prev => ({ ...prev, [taskId]: true }));
    try {
      await fetch(`/api/tasks/${taskId}/trigger`, {
        method: 'POST'
      });
      fetchTasks();
      // Refresh logs after task completes (retry a few times to catch the write)
      [2000, 5000].forEach(delay => {
        setTimeout(() => {
          if (expandedRef.current === taskId) {
            loadTaskLogs(taskId, true);
          }
        }, delay);
      });
    } catch (e) {
      console.error('Failed to trigger task:', e);
    }
    // Re-enable after 3 seconds
    setTimeout(() => {
      setTriggerCooldown(prev => ({ ...prev, [taskId]: false }));
    }, 3000);
  };

  const loadTaskLogs = async (taskId, force = false) => {
    if (!force && taskLogs[taskId]) return;
    const node = selectedNodeRef.current;
    setLoadingLogs(prev => ({ ...prev, [taskId]: true }));
    try {
      const nodeParam = node ? `?node=${node}` : '';
      const res = await fetch(`/api/tasks/${taskId}/logs${nodeParam}`);
      if (res.ok) {
        const data = await res.json();
        setTaskLogs(prev => ({ ...prev, [taskId]: data }));
      }
    } catch (e) {
      console.error('Failed to load task logs:', e);
    } finally {
      setLoadingLogs(prev => ({ ...prev, [taskId]: false }));
    }
  };

  const loadLogContent = async (taskId, filename, logNodeId) => {
    if (logContent[filename]) {
      setLogContent(prev => ({ ...prev, [filename]: null }));
      return;
    }
    setLoadingContent(prev => ({ ...prev, [filename]: true }));
    try {
      const node = logNodeId || selectedNodeRef.current;
      const nodeParam = node ? `?node=${node}` : '';
      const res = await fetch(`/api/tasks/${taskId}/logs/${filename}${nodeParam}`);
      if (res.ok) {
        const data = await res.json();
        setLogContent(prev => ({ ...prev, [filename]: data.content }));
      }
    } catch (e) {
      console.error('Failed to load log content:', e);
    } finally {
      setLoadingContent(prev => ({ ...prev, [filename]: false }));
    }
  };

  const handleExpand = (taskId) => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      expandedRef.current = null;
    } else {
      setExpandedTask(taskId);
      expandedRef.current = taskId;
      loadTaskLogs(taskId);
    }
  };

  if (loading) return <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>Loading tasks...</div>;

  return (
    <section>
      <h2 style={{ fontSize: '1.5em' }}>Scheduler & Tasks</h2>

      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <label style={{ fontWeight: 'bold', color: '#475569' }}>View node:</label>
        <select
          value={selectedNode}
          onChange={e => {
            const val = e.target.value;
            setSelectedNode(val);
            selectedNodeRef.current = val;
            setTaskLogs({});
            setLogContent({});
            // Reload logs for currently expanded task
            if (expandedRef.current) {
              setTimeout(() => loadTaskLogs(expandedRef.current, true), 0);
            }
          }}
          style={{ padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: '4px', background: 'white', fontSize: '0.9em' }}
        >
          <option value="">All Nodes</option>
          {nodes.map(node => (
            <option key={node.id} value={node.id}>{node.name} ({node.ip})</option>
          ))}
        </select>
        {loadingNodes && <span style={{ color: '#94a3b8', fontSize: '0.85em' }}>Loading nodes...</span>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em' }}>
            <th style={{ padding: '12px 10px' }}>Task Name</th>
            <th style={{ padding: '12px 10px' }}>Schedule</th>
            <th style={{ padding: '12px 10px' }}>Status</th>
            <th style={{ padding: '12px 10px' }}>Last Run</th>
            <th style={{ padding: '12px 10px' }}>Node</th>
            <th style={{ padding: '12px 10px' }}>Next Run</th>
            <th style={{ padding: '12px 10px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <React.Fragment key={task.id}>
              <tr style={{
                borderBottom: '1px solid #f1f5f9',
                background: task.status === 'running' ? '#f0f9ff' : 'transparent',
                cursor: 'pointer'
              }}
                onClick={() => handleExpand(task.id)}
              >
                <td style={{ padding: '15px 10px' }}>
                  <div style={{ fontWeight: 'bold', color: '#1e293b' }}>{task.name}</div>
                </td>
                <td style={{ padding: '15px 10px', color: '#64748b', fontSize: '0.9em' }}>{task.scheduleDesc}</td>
                <td style={{ padding: '15px 10px' }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '4px 8px',
                    borderRadius: '12px',
                    fontSize: '0.8em',
                    fontWeight: 'bold',
                    background: task.status === 'running' ? '#dbeafe' : task.status === 'failed' ? '#fee2e2' : task.status === 'success' ? '#d1fae5' : '#f1f5f9',
                    color: task.status === 'running' ? '#2563eb' : task.status === 'failed' ? '#dc2626' : task.status === 'success' ? '#059669' : '#64748b'
                  }}>
                    {task.status.toUpperCase()}
                  </span>
                  {!task.enabled && (
                    <span style={{ marginLeft: '8px', fontSize: '0.8em', color: '#ef4444', fontWeight: 'bold' }}>(PAUSED)</span>
                  )}
                </td>
                <td style={{ padding: '15px 10px', color: '#64748b', fontSize: '0.9em' }}>
                  {task.lastRun ? new Date(task.lastRun).toLocaleString() : 'Never'}
                </td>
                <td style={{ padding: '15px 10px', fontSize: '0.9em' }}>
                  {task.lastRunNode ? (
                    <span style={{
                      display: 'inline-block', padding: '3px 8px', borderRadius: '10px',
                      background: '#e0e7ff', color: '#3730a3', fontWeight: 'bold', fontSize: '0.85em'
                    }}>
                      {task.lastRunNode}
                    </span>
                  ) : (
                    <span style={{ color: '#94a3b8' }}>—</span>
                  )}
                </td>
                <td style={{ padding: '15px 10px', color: '#64748b', fontSize: '0.9em' }}>
                  {task.nextRun ? new Date(task.nextRun).toLocaleString() : 'N/A'}
                </td>
                <td style={{ padding: '15px 10px', textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => triggerTask(task.id)}
                      disabled={task.status === 'running' || !task.enabled || triggerCooldown[task.id]}
                      style={{
                        background: '#f8fafc', color: (task.status === 'running' || !task.enabled || triggerCooldown[task.id]) ? '#cbd5e1' : '#3b82f6',
                        border: '1px solid #e2e8f0', padding: '6px 12px', borderRadius: '4px', cursor: (task.status === 'running' || !task.enabled || triggerCooldown[task.id]) ? 'not-allowed' : 'pointer',
                        fontSize: '0.85em', fontWeight: 'bold'
                      }}
                    >
                      Run Now
                    </button>
                    <button
                      onClick={() => toggleTask(task.id, !task.enabled)}
                      style={{
                        background: '#f8fafc', color: task.enabled ? '#ef4444' : '#10b981',
                        border: '1px solid #e2e8f0', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer',
                        fontSize: '0.85em', fontWeight: 'bold'
                      }}
                    >
                      {task.enabled ? 'Pause' : 'Resume'}
                    </button>
                  </div>
                </td>
              </tr>
              {expandedTask === task.id && (
                <tr>
                  <td colSpan="7" style={{ padding: '0 10px 15px 10px', background: '#fafafa', borderBottom: '1px solid #e2e8f0' }}>
                    <div style={{
                      background: '#1e293b',
                      color: '#e2e8f0',
                      fontFamily: 'monospace',
                      fontSize: '0.85em',
                      padding: '12px 16px',
                      borderRadius: '6px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      maxHeight: '200px',
                      overflowY: 'auto',
                      marginTop: '10px'
                    }}>
                      {task.lastOutput || (task.lastRun ? 'Task completed with no output.' : 'Task has not run yet.')}
                    </div>
                    {task.lastExitCode !== undefined && (
                      <div style={{ marginTop: '6px', fontSize: '0.85em', color: task.lastExitCode === 0 ? '#059669' : '#dc2626' }}>
                        Exit code: {task.lastExitCode}
                      </div>
                    )}

                    <div style={{ marginTop: '15px', borderTop: '1px solid #e2e8f0', paddingTop: '10px' }}>
                      <h4 style={{ margin: '0 0 8px 0', fontSize: '0.95em', color: '#475569' }}>Run History</h4>
                      {loadingLogs[task.id] ? (
                        <div style={{ color: '#94a3b8', fontSize: '0.85em' }}>Loading logs...</div>
                      ) : taskLogs[task.id] && taskLogs[task.id].length > 0 ? (
                        <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                          {taskLogs[task.id].map(log => (
                            <div key={log.filename}>
                              <div
                                onClick={() => loadLogContent(task.id, log.filename, log.nodeId)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '12px',
                                  padding: '6px 8px', cursor: 'pointer', borderRadius: '4px',
                                  fontSize: '0.85em', color: '#3b82f6', fontWeight: 'bold',
                                }}
                              >
                                <span style={{ color: '#64748b', fontWeight: 'normal' }}>{new Date(log.timestamp).toLocaleString()}</span>
                                <span style={{ color: logContent[log.filename] ? '#64748b' : '#3b82f6' }}>
                                  {logContent[log.filename] ? '▼' : '▶'} Exit code: {log.exitCode !== null && log.exitCode !== undefined ? log.exitCode : '?'}
                                </span>
                                {log.nodeId && !selectedNode && (
                                  <span style={{ color: '#6366f1', fontWeight: 'bold', fontSize: '0.85em' }}>[{log.nodeId}]</span>
                                )}
                                <span style={{ color: '#94a3b8', fontWeight: 'normal' }}>({(log.size / 1024).toFixed(1)} KB)</span>
                              </div>
                              {logContent[log.filename] && (
                                <div style={{
                                  background: '#1e293b', color: '#e2e8f0', fontFamily: 'monospace',
                                  fontSize: '0.8em', padding: '10px 14px', borderRadius: '4px',
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                  maxHeight: '300px', overflowY: 'auto', margin: '0 8px 8px 8px'
                                }}>
                                  {logContent[log.filename]}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ color: '#94a3b8', fontSize: '0.85em' }}>No run logs yet.</div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}