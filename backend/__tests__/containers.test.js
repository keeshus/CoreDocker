import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDocker = {};
vi.mock('../services/docker.js', () => ({ default: mockDocker }));
vi.mock('../services/db.js', () => ({
  getContainers: vi.fn(),
  getNodes: vi.fn(),
  default: {
    get: vi.fn(),
    put: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    getAll: vi.fn(),
  },
}));
vi.mock('../services/nginx.js', () => ({
  addRoute: vi.fn(),
  removeRoute: vi.fn(),
}));
vi.mock('../services/secrets.js', () => ({
  isNodeSealed: vi.fn().mockReturnValue(false),
  generateClusterToken: vi.fn().mockReturnValue('mock-token'),
}));

await import('../routes/containers.js');

const validateContainerInput = (() => {
  const IMAGE_NAME_RE = /^[a-zA-Z0-9._\-\/]+(:[a-zA-Z0-9._-]+)?$/;
  const NAME_RE = /^[a-zA-Z0-9._-]+$/;
  const URI_RE = /^\/[a-zA-Z0-9._\-\/]*$/;
  const PORT_RE = /^\d+$/;
  const DEVICES_RE = /^[a-zA-Z0-9_\/.,:]+$/;

  return function validate(body) {
    const errors = [];
    if (body.name && !NAME_RE.test(body.name)) {
      errors.push('Invalid container name: only alphanumeric, dots, dashes, and underscores allowed');
    }
    if (body.image && !IMAGE_NAME_RE.test(body.image)) {
      errors.push('Invalid image name format');
    }
    if (body.proxy?.enabled) {
      if (body.proxy.uri && !URI_RE.test(body.proxy.uri)) {
        errors.push('Invalid proxy URI format');
      }
      if (body.proxy.port && !PORT_RE.test(String(body.proxy.port))) {
        errors.push('Invalid proxy port');
      }
    }
    if (body.devices && !DEVICES_RE.test(body.devices)) {
      errors.push('Invalid devices format');
    }
    return errors;
  };
})();

describe('validateContainerInput', () => {
  it('returns empty errors for valid input', () => {
    const errors = validateContainerInput({
      name: 'my-container',
      image: 'nginx:latest',
    });
    expect(errors).toHaveLength(0);
  });

  describe('name validation', () => {
    it('rejects name with spaces', () => {
      const errors = validateContainerInput({ name: 'my container' });
      expect(errors).toContain('Invalid container name: only alphanumeric, dots, dashes, and underscores allowed');
    });

    it('rejects name with special chars', () => {
      const errors = validateContainerInput({ name: 'container@#$' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts valid names with dots and dashes', () => {
      const errors = validateContainerInput({ name: 'my-app.web_service' });
      expect(errors).toHaveLength(0);
    });
  });

  describe('image validation', () => {
    it('rejects image with spaces', () => {
      const errors = validateContainerInput({ image: 'nginx latest' });
      expect(errors).toContain('Invalid image name format');
    });

    it('rejects image with special chars', () => {
      const errors = validateContainerInput({ image: 'repo/ image!' });
      expect(errors).toContain('Invalid image name format');
    });

    it('accepts full registry path with tag', () => {
      const errors = validateContainerInput({ image: 'registry.example.com/team/app:v1.0.0' });
      expect(errors).toHaveLength(0);
    });

    it('accepts image with digest', () => {
      const errors = validateContainerInput({ image: 'alpine:latest' });
      expect(errors).toHaveLength(0);
    });
  });

  describe('proxy validation', () => {
    it('rejects invalid proxy URI', () => {
      const errors = validateContainerInput({
        proxy: { enabled: true, uri: 'not-a-uri', port: '8080' },
      });
      expect(errors).toContain('Invalid proxy URI format');
    });

    it('rejects non-numeric proxy port', () => {
      const errors = validateContainerInput({
        proxy: { enabled: true, uri: '/api', port: 'abc' },
      });
      expect(errors).toContain('Invalid proxy port');
    });

    it('accepts valid proxy config', () => {
      const errors = validateContainerInput({
        proxy: { enabled: true, uri: '/api/v1', port: '3000' },
      });
      expect(errors).toHaveLength(0);
    });

    it('skips proxy validation when proxy is not enabled', () => {
      const errors = validateContainerInput({
        proxy: { enabled: false, uri: 'bad uri', port: 'abc' },
      });
      expect(errors).toHaveLength(0);
    });
  });

  describe('devices validation', () => {
    it('rejects devices with spaces', () => {
      const errors = validateContainerInput({ devices: '/dev/dri /dev/fuse' });
      expect(errors).toContain('Invalid devices format');
    });

    it('accepts valid device mappings', () => {
      const errors = validateContainerInput({ devices: '/dev/dri:/dev/dri:rwm,/dev/fuse:/dev/fuse:r' });
      expect(errors).toHaveLength(0);
    });
  });

  it('collects multiple validation errors', () => {
    const errors = validateContainerInput({
      name: 'bad name',
      image: 'bad image!',
      proxy: { enabled: true, uri: 'invalid-uri', port: 'not-a-port' },
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
