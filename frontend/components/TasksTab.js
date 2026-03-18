import React, { useState, useEffect } from 'react';

export default function TasksTab() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

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
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
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

  const triggerTask = async (taskId) => {
    try {
      await fetch(`/api/tasks/${taskId}/trigger`, {
        method: 'POST'
      });
      fetchTasks();
    } catch (e) {
      console.error('Failed to trigger task:', e);
    }
  };

  if (loading) return <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>Loading tasks...</div>;

  return (
    <section>
      <h2 style={{ fontSize: '1.5em' }}>Scheduler & Tasks</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em' }}>
            <th style={{ padding: '12px 10px' }}>Task Name</th>
            <th style={{ padding: '12px 10px' }}>Schedule</th>
            <th style={{ padding: '12px 10px' }}>Status</th>
            <th style={{ padding: '12px 10px' }}>Last Run</th>
            <th style={{ padding: '12px 10px' }}>Next Run</th>
            <th style={{ padding: '12px 10px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <tr key={task.id} style={{ borderBottom: '1px solid #f1f5f9', background: task.status === 'running' ? '#f0f9ff' : 'transparent' }}>
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
              <td style={{ padding: '15px 10px', color: '#64748b', fontSize: '0.9em' }}>
                {task.nextRun ? new Date(task.nextRun).toLocaleString() : 'N/A'}
              </td>
              <td style={{ padding: '15px 10px', textAlign: 'right' }}>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => triggerTask(task.id)}
                    disabled={task.status === 'running' || !task.enabled}
                    style={{
                      background: '#f8fafc', color: (task.status === 'running' || !task.enabled) ? '#cbd5e1' : '#3b82f6',
                      border: '1px solid #e2e8f0', padding: '6px 12px', borderRadius: '4px', cursor: (task.status === 'running' || !task.enabled) ? 'not-allowed' : 'pointer',
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
          ))}
        </tbody>
      </table>
    </section>
  );
}
