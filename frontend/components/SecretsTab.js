import React, { useState, useEffect } from 'react';
import { Lock, Plus, Trash2, Key } from 'lucide-react';

export default function SecretsTab() {
  const [secrets, setSecrets] = useState([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchSecrets = async () => {
    try {
      const res = await fetch('/api/proxy/secrets');
      const data = await res.json();
      setSecrets(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSecrets();
  }, []);

  const handleAddSecret = async (e) => {
    e.preventDefault();
    if (!newKey || !newValue) return;
    
    try {
      const res = await fetch('/api/proxy/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey, value: newValue }),
      });
      if (res.ok) {
        setNewKey('');
        setNewValue('');
        fetchSecrets();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteSecret = async (key) => {
    try {
      const res = await fetch(`/api/proxy/secrets/${key}`, { method: 'DELETE' });
      if (res.ok) fetchSecrets();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="font-mono text-zinc-300">
      <div className="bg-zinc-900 border border-zinc-800 rounded mb-8 p-6">
        <h2 className="text-xl text-zinc-100 mb-4 flex items-center gap-2">
          <Key size={20} /> Add New Secret
        </h2>
        <form onSubmit={handleAddSecret} className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-xs uppercase text-zinc-500 mb-2 font-semibold">Secret Key</label>
            <input
              type="text"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
              placeholder="e.g. CLOUDFLARE_API_KEY"
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-zinc-100 focus:border-zinc-500 focus:outline-none transition-colors"
              required
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs uppercase text-zinc-500 mb-2 font-semibold">Secret Value</label>
            <input
              type="password"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder="Enter secure value"
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-zinc-100 focus:border-zinc-500 focus:outline-none transition-colors"
              required
            />
          </div>
          <button
            type="submit"
            className="bg-zinc-100 text-zinc-950 hover:bg-white px-6 py-2 rounded flex items-center gap-2 font-bold transition-colors"
          >
            <Plus size={18} /> Save Secret
          </button>
        </form>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-zinc-950 border-b border-zinc-800">
              <th className="p-4 text-xs uppercase text-zinc-500 font-semibold">Secret Key</th>
              <th className="p-4 text-xs uppercase text-zinc-500 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="2" className="p-8 text-center text-zinc-500">Loading secrets...</td></tr>
            ) : secrets.length === 0 ? (
              <tr><td colSpan="2" className="p-8 text-center text-zinc-500">No secrets found.</td></tr>
            ) : secrets.map(key => (
              <tr key={key} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                <td className="p-4 font-medium text-zinc-200">{key}</td>
                <td className="p-4 text-right">
                  <button
                    onClick={() => handleDeleteSecret(key)}
                    className="text-zinc-500 hover:text-red-400 transition-colors"
                    title="Delete Secret"
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