import app from '../src/app.js';
import { closePool, testConnection } from '../src/config/db.js';

let server = null;
let baseUrl = '';

/**
 * Start test server on ephemeral port
 */
export async function startTestServer() {
  await testConnection();
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve({ server, baseUrl });
    });
  });
}

/**
 * Stop test server and close DB pool
 */
export async function stopTestServer() {
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    try {
      server.unref();
    } catch {}
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
}

export function getBaseUrl() {
  return baseUrl;
}

/**
 * Convenience HTTP request helper
 */
export async function apiRequest(endpoint, { method = 'GET', body = null, token = null } = {}) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, options);
  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else {
    data = await response.text().catch(() => null);
  }

  return {
    status: response.status,
    headers: response.headers,
    data
  };
}

/**
 * Multipart/form-data upload request helper
 */
export async function apiUploadRequest(endpoint, { formData, token = null }) {
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: formData
  });

  const data = await response.json().catch(() => null);
  return {
    status: response.status,
    headers: response.headers,
    data
  };
}
