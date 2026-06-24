import React, { useState, useEffect, useRef } from 'react';

export default function TasksTab() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedTask, setExpandedTask] = useState(null);
  const expandedRef = useRef(null);
  const [taskLogs, setTaskLogs] = useState({});
  const taskLogsRef = useRef({});
  useEffect(() => { taskLogsRef.current = taskLogs; }, [taskLogs]);
  const [loadingLogs, setLoadingLogs] = useState({});
  const [logContent, setLogContent] = useState({});
  const [loadingContent, setLoadingContent] = useState({});
  const [nodes, setNodes] = useState([]);
  const [selectedNode, setSelectedNode] = useState('');
  const selectedNodeRef = useRef('');
  useEffect(() => { selectedNodeRef.current = selectedNode; }, [selectedNode]);
  const [loadingNodes, setLoadingNodes] = useState(true);

  const fetchTasks = async (nodeId) => {
    try {
      const nid = nodeId || selectedNodeRef.current;
      const url = nid ? `/api/tasks?node=${nid}` : '/api/tasks';
      const res = await fetch(url);
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
    setTimeout(() => {
      setTriggerCooldown(prev => ({ ...prev, [taskId]: false }));
    }, 3000);
  };

  const LOGS_PER_PAGE = 10;

  const loadTaskLogs = async (taskId, force = false) => {
    const currentLogs = taskLogsRef.current;
    if (!force && currentLogs[taskId]) return;
    const node = selectedNodeRef.current;
    const prevExtra = force && currentLogs[taskId]?.files
      ? currentLogs[taskId].files.slice(LOGS_PER_PAGE) : [];
    setLoadingLogs(prev => ({ ...prev, [taskId]: true }));
    try {
      const nodeParam = node ? `&node=${node}` : '';
      const res = await fetch(`/api/tasks/${taskId}/logs?page=1&limit=${LOGS_PER_PAGE}${nodeParam}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setTaskLogs(prev => ({ ...prev, [taskId]: { files: data, total: data.length, page: 1, totalPages: 1 } }));
        } else {
          setTaskLogs(prev => ({
            ...prev,
            [taskId]: {
              ...data,
              files: [...(data.files || []), ...prevExtra],
            },
          }));
        }
      }
    } catch (e) {
      console.error('Failed to load task logs:', e);
    } finally {
      setLoadingLogs(prev => ({ ...prev, [taskId]: false }));
    }
  };

  const loadMoreLogs = async (taskId) => {
    const current = taskLogsRef.current[taskId];
    if (!current || current.page >= current.totalPages) return;

    const node = selectedNodeRef.current;
    const nextPage = current.page + 1;
    setLoadingLogs(prev => ({ ...prev, [taskId]: true }));
    try {
      const nodeParam = node ? `&node=${node}` : '';
      const res = await fetch(`/api/tasks/${taskId}/logs?page=${nextPage}&limit=${LOGS_PER_PAGE}${nodeParam}`);
      if (res.ok) {
        const data = await res.json();
        const newFiles = data.files || (Array.isArray(data) ? data : []);
        const newTotal = data.total || newFiles.length;
        const newTotalPages = data.totalPages || 1;
        setTaskLogs(prev => {
          const cur = prev[taskId];
          return {
            ...prev,
            [taskId]: {
              files: [...(cur?.files || []), ...newFiles],
              total: newTotal,
              page: nextPage,
              totalPages: newTotalPages,
            },
          };
        });
      }
    } catch (e) {
      console.error('Failed to load more logs:', e);
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

  if (loading) return (
    <div style={{
      padding: '20px', fontFamily: 'var(--md-font)',
      color: 'var(--md-on-surface-variant)',
    }}>
      Loading tasks...
    </div>
  );

  return (
    <section>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '20px',
      }}>
        <h2 style={{
          fontSize: '1.35rem', fontWeight: 600, color: 'var(--md-on-surface)',
          margin: 0, letterSpacing: '-0.01em',
        }}>
          Scheduler & Tasks
        </h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{
            fontWeight: 500, color: 'var(--md-on-surface-variant)',
            fontSize: '0.875rem',
          }}>
            View node:
          </label>
          <select
            value={selectedNode}
            onChange={e => {
              const val = e.target.value;
              setSelectedNode(val);
              selectedNodeRef.current = val;
              setTaskLogs({});
              setLogContent({});
              setLoading(true);
              fetchTasks(val);
              if (expandedRef.current) {
                setTimeout(() => loadTaskLogs(expandedRef.current, true), 0);
              }
            }}
            style={{
              padding: '8px 36px 8px 12px',
              border: '1px solid var(--md-outline)',
              borderRadius: 'var(--md-radius-full)',
              background: 'var(--md-surface)',
              color: 'var(--md-on-surface)',
              fontSize: '0.875rem',
              fontFamily: 'var(--md-font)',
              cursor: 'pointer',
              appearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' height='20' viewBox='0 -960 960 960' width='20' fill='%2344474f'%3E%3Cpath d='M480-344 240-584l43-43 197 197 197-197 43 43-240 240Z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 8px center',
            }}
          >
            <option value="">All Nodes</option>
            {nodes.map(node => (
              <option key={node.id} value={node.id}>{node.name} ({node.ip})</option>
            ))}
          </select>
          {loadingNodes && (
            <span style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
              Loading...
            </span>
          )}
        </div>
      </div>

      <table style={{
        width: '100%', borderCollapse: 'collapse',
        background: 'var(--md-surface-container)',
        borderRadius: 'var(--md-radius-lg)',
        overflow: 'hidden',
        border: '1px solid var(--md-outline-variant)',
      }}>
        <thead>
          <tr style={{
            textAlign: 'left',
            borderBottom: '1px solid var(--md-outline-variant)',
            color: 'var(--md-on-surface-variant)',
            fontSize: '0.8rem', fontWeight: 600,
            background: 'var(--md-surface)',
          }}>
            <th style={{ padding: '12px 16px' }}>Task Name</th>
            <th style={{ padding: '12px 16px' }}>Schedule</th>
            <th style={{ padding: '12px 16px' }}>Status</th>
            <th style={{ padding: '12px 16px' }}>Last Run</th>
            <th style={{ padding: '12px 16px' }}>Node</th>
            <th style={{ padding: '12px 16px' }}>Next Run</th>
            <th style={{ padding: '12px 16px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <React.Fragment key={task.id}>
              <tr style={{
                borderBottom: '1px solid var(--md-outline-variant)',
                background: task.status === 'running' ? 'var(--md-primary-container)' : 'transparent',
                cursor: 'pointer',
                transition: 'background var(--md-transition)',
              }}
                onClick={() => handleExpand(task.id)}
              >
                <td style={{ padding: '14px 16px' }}>
                  <div style={{ fontWeight: 600, color: 'var(--md-on-surface)', fontSize: '0.9rem' }}>
                    {expandedTask === task.id ? '▼ ' : '▶ '}{task.name}
                  </div>
                </td>
                <td style={{ padding: '14px 16px', color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
                  {task.scheduleDesc}
                </td>
                <td style={{ padding: '14px 16px' }}>
                  <span style={{
                    display: 'inline-block', padding: '4px 10px',
                    borderRadius: 'var(--md-radius-full)', fontSize: '0.75rem', fontWeight: 600,
                    background: task.status === 'running' ? 'var(--md-status-running-bg)'
                      : task.status === 'failed' ? 'var(--md-status-failed-bg)'
                      : task.status === 'success' ? 'var(--md-status-success-bg)'
                      : 'var(--md-status-idle-bg)',
                    color: task.status === 'running' ? 'var(--md-status-running)'
                      : task.status === 'failed' ? 'var(--md-status-failed)'
                      : task.status === 'success' ? 'var(--md-status-success)'
                      : 'var(--md-status-idle)',
                  }}>
                    {task.status.toUpperCase()}
                  </span>
                  {!task.enabled && (
                    <span style={{
                      marginLeft: '8px', fontSize: '0.75rem',
                      color: 'var(--md-status-paused)', fontWeight: 600,
                    }}>
                      (PAUSED)
                    </span>
                  )}
                </td>
                <td style={{ padding: '14px 16px', color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
                  {task.lastRun ? new Date(task.lastRun).toLocaleString() : 'Never'}
                </td>
                <td style={{ padding: '14px 16px', fontSize: '0.85rem' }}>
                  {task.lastRunNode ? (
                    <span style={{
                      display: 'inline-block', padding: '3px 10px',
                      borderRadius: 'var(--md-radius-full)',
                      background: 'var(--md-secondary-container)',
                      color: 'var(--md-on-secondary-container)',
                      fontWeight: 600, fontSize: '0.8rem',
                    }}>
                      {task.lastRunNode}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--md-on-surface-variant)' }}>&mdash;</span>
                  )}
                </td>
                <td style={{ padding: '14px 16px', color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
                  {task.nextRun ? new Date(task.nextRun).toLocaleString() : 'N/A'}
                </td>
                <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => triggerTask(task.id)}
                      disabled={task.status === 'running' || !task.enabled || triggerCooldown[task.id]}
                      style={{
                        padding: '6px 14px', borderRadius: 'var(--md-radius-full)',
                        border: '1px solid var(--md-outline-variant)',
                        background: 'var(--md-surface)',
                        color: (task.status === 'running' || !task.enabled || triggerCooldown[task.id])
                          ? 'var(--md-outline)' : 'var(--md-primary)',
                        cursor: (task.status === 'running' || !task.enabled || triggerCooldown[task.id])
                          ? 'not-allowed' : 'pointer',
                        fontSize: '0.8rem', fontWeight: 600,
                        fontFamily: 'var(--md-font)',
                      }}
                    >
                      Run Now
                    </button>
                    <button
                      onClick={() => toggleTask(task.id, !task.enabled)}
                      style={{
                        padding: '6px 14px', borderRadius: 'var(--md-radius-full)',
                        border: '1px solid var(--md-outline-variant)',
                        background: 'var(--md-surface)',
                        color: task.enabled ? 'var(--md-error)' : 'var(--md-success)',
                        cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                        fontFamily: 'var(--md-font)',
                      }}
                    >
                      {task.enabled ? 'Pause' : 'Resume'}
                    </button>
                  </div>
                </td>
              </tr>
              {expandedTask === task.id && (
                <tr>
                  <td colSpan="7" style={{
                    padding: '0 16px 16px 16px',
                    background: 'var(--md-surface)', borderBottom: '1px solid var(--md-outline-variant)',
                  }}>
                    <div style={{
                      background: 'var(--md-inverse-surface)',
                      color: 'var(--md-inverse-on-surface)',
                      fontFamily: 'var(--md-font-mono)',
                      fontSize: '0.85rem',
                      padding: '12px 16px',
                      borderRadius: 'var(--md-radius-md)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      maxHeight: '200px',
                      overflowY: 'auto',
                      marginTop: '10px',
                    }}>
                      {task.lastOutput || (task.lastRun ? 'Task completed with no output.' : 'Task has not run yet.')}
                    </div>
                    {task.lastExitCode !== undefined && (
                      <div style={{
                        marginTop: '6px', fontSize: '0.85rem',
                        color: task.lastExitCode === 0 ? 'var(--md-success)' : 'var(--md-error)',
                      }}>
                        Exit code: {task.lastExitCode}
                      </div>
                    )}

                    <div style={{ marginTop: '15px', borderTop: '1px solid var(--md-outline-variant)', paddingTop: '10px' }}>
                      <h4 style={{
                        margin: '0 0 8px 0', fontSize: '0.95rem',
                        color: 'var(--md-on-surface-variant)', fontWeight: 600,
                      }}>
                        Run History
                      </h4>
                      {(() => {
                        const logs = taskLogs[task.id];
                        const logFiles = logs?.files || (Array.isArray(logs) ? logs : []);
                        const hasMore = logs?.page < logs?.totalPages;

                        return (<>
                      {loadingLogs[task.id] ? (
                        <div style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
                          Loading logs...
                        </div>
                      ) : logFiles.length > 0 ? (
                        <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                          {logFiles.map(log => (
                            <div key={log.filename}>
                              <div
                                onClick={() => loadLogContent(task.id, log.filename, log.nodeId)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '12px',
                                  padding: '6px 8px', cursor: 'pointer', borderRadius: 'var(--md-radius-sm)',
                                  fontSize: '0.85rem',
                                  transition: 'background var(--md-transition)',
                                }}
                              >
                                <span style={{ color: 'var(--md-on-surface-variant)', fontWeight: 400 }}>
                                  {new Date(log.timestamp).toLocaleString()}
                                </span>
                                <span style={{
                                  color: logContent[log.filename] ? 'var(--md-on-surface-variant)' : 'var(--md-primary)',
                                  fontWeight: 600,
                                }}>
                                  {logContent[log.filename] ? '▼' : '▶'} Exit code: {log.exitCode !== null && log.exitCode !== undefined ? log.exitCode : '?'}
                                </span>
                                {log.nodeId && !selectedNode && (
                                  <span style={{
                                    color: 'var(--md-tertiary)', fontWeight: 600, fontSize: '0.85rem',
                                  }}>
                                    [{log.nodeId}]
                                  </span>
                                )}
                                <span style={{ color: 'var(--md-on-surface-variant)', fontWeight: 400 }}>
                                  ({(log.size / 1024).toFixed(1)} KB)
                                </span>
                              </div>
                              {logContent[log.filename] && (
                                <div style={{
                                  background: 'var(--md-inverse-surface)',
                                  color: 'var(--md-inverse-on-surface)',
                                  fontFamily: 'var(--md-font-mono)',
                                  fontSize: '0.8rem', padding: '10px 14px',
                                  borderRadius: 'var(--md-radius-md)',
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                  maxHeight: '300px', overflowY: 'auto',
                                  margin: '0 8px 8px 8px',
                                }}>
                                  {logContent[log.filename]}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
                          No run logs yet.
                        </div>
                      )}

                      {hasMore && (
                        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ fontSize: '0.8rem', color: 'var(--md-on-surface-variant)' }}>
                            Showing {logFiles.length} of {logs.total} runs
                          </span>
                          <button
                            onClick={() => loadMoreLogs(task.id)}
                            disabled={loadingLogs[task.id]}
                            style={{
                              padding: '4px 14px', fontSize: '0.8rem', cursor: 'pointer',
                              borderRadius: 'var(--md-radius-full)',
                              background: 'var(--md-surface)',
                              color: 'var(--md-primary)',
                              border: '1px solid var(--md-outline-variant)',
                              fontWeight: 600, fontFamily: 'var(--md-font)',
                            }}
                          >
                            {loadingLogs[task.id] ? 'Loading...' : 'Load more'}
                          </button>
                        </div>
                      )}
                      </>);
                    })()}
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
