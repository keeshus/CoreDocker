import React, { useState, useEffect } from 'react';
import { Settings, Plus, Trash2, Server } from 'lucide-react';

export default function NodesTab() {
  const [nodes, setNodes] = useState([]);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeIp, setNewNodeIp] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchNodes = async () => {
    try {
      const res = await fetch('/api/proxy/nodes');
      const data = await res.json();
      setNodes(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
  }, []);

  const handleAddNode = async (e) => {
    e.preventDefault();
    if (!newNodeName || !newNodeIp) return;
    
    try {
      const res = await fetch('/api/proxy/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newNodeName, ip: newNodeIp }),
      });
      if (res.ok) {
        setNewNodeName('');
        setNewNodeIp('');
        fetchNodes();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteNode = async (id) => {
    try {
      const res = await fetch(`/api/proxy/nodes/${id}`, { method: 'DELETE' });
      if (res.ok) fetchNodes();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="font-mono text-zinc-300">
      <div className="bg-zinc-900 border border-zinc-800 rounded mb-8 p-6">
        <h2 className="text-xl text-zinc-100 mb-4 flex items-center gap-2">
          <Settings size={20} /> Register New Node
        </h2>
        <form onSubmit={handleAddNode} className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-xs uppercase text-zinc-500 mb-2 font-semibold">Node Name</label>
            <input
              type="text"
              value={newNodeName}
              onChange={e => setNewNodeName(e.target.value)}
              placeholder="e.g. worker-01"
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-zinc-100 focus:border-zinc-500 focus:outline-none transition-colors"
              required
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs uppercase text-zinc-500 mb-2 font-semibold">IP Address</label>
            <input
              type="text"
              value={newNodeIp}
              onChange={e => setNewNodeIp(e.target.value)}
              placeholder="e.g. 192.168.1.100"
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-zinc-100 focus:border-zinc-500 focus:outline-none transition-colors"
              required
            />
          </div>
          <button
            type="submit"
            className="bg-zinc-100 text-zinc-950 hover:bg-white px-6 py-2 rounded flex items-center gap-2 font-bold transition-colors"
          >
            <Plus size={18} /> Add Node
          </button>
        </form>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-zinc-950 border-b border-zinc-800">
              <th className="p-4 text-xs uppercase text-zinc-500 font-semibold">Name</th>
              <th className="p-4 text-xs uppercase text-zinc-500 font-semibold">IP Address</th>
              <th className="p-4 text-xs uppercase text-zinc-500 font-semibold">Status</th>
              <th className="p-4 text-xs uppercase text-zinc-500 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="4" className="p-8 text-center text-zinc-500">Loading nodes...</td></tr>
            ) : nodes.length === 0 ? (
              <tr><td colSpan="4" className="p-8 text-center text-zinc-500">No nodes registered.</td></tr>
            ) : nodes.map(node => (
              <tr key={node.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                <td className="p-4 font-medium text-zinc-200">{node.name}</td>
                <td className="p-4 text-zinc-400">{node.ip}</td>
                <td className="p-4">
                  <span className={`px-2 py-1 rounded text-xs font-bold ${node.status === 'online' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                    {node.status}
                  </span>
                </td>
                <td className="p-4 text-right">
                  <button
                    onClick={() => handleDeleteNode(node.id)}
                    className="text-zinc-500 hover:text-red-400 transition-colors"
                    title="Remove Node"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}