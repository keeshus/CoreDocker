import etcd from './db.js';
import crypto from 'crypto';

const SECRETS_PREFIX = 'secrets/';
// A master key should ideally be injected via env vars or docker swarm secret.
// For now, we use a static one or generate one and keep it in memory for demo.
const ENCRYPTION_KEY = process.env.SECRET_MANAGER_KEY || crypto.randomBytes(32).toString('hex');

const encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

export const getSecret = async (key) => {
  const encryptedValue = await etcd.get(`${SECRETS_PREFIX}${key}`).string();
  if (!encryptedValue) return null;
  return decrypt(encryptedValue);
};

export const setSecret = async (key, value) => {
  const encryptedValue = encrypt(value);
  await etcd.put(`${SECRETS_PREFIX}${key}`).value(encryptedValue);
};

export const deleteSecret = async (key) => {
  await etcd.delete().key(`${SECRETS_PREFIX}${key}`);
};

export const getAllSecretKeys = async () => {
  const allSecrets = await etcd.getAll().prefix(SECRETS_PREFIX).keys();
  return allSecrets.map(k => k.replace(SECRETS_PREFIX, ''));
};
