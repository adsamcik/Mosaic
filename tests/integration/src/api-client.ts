/**
 * API Test Client
 *
 * HTTP client for integration tests against the Mosaic backend API.
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';

export class ApiClient {
  private baseUrl: string;
  private authUser: string | null = null;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Set the authenticated user for subsequent requests
   */
  setUser(username: string): void {
    this.authUser = username;
  }

  /**
   * Clear authentication
   */
  clearAuth(): void {
    this.authUser = null;
  }

  /**
   * Make an API request
   */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
    } = {}
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add auth header if user is set
    if (this.authUser) {
      headers['Remote-User'] = this.authUser;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let data: T;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = (await response.text()) as unknown as T;
    }

    return {
      status: response.status,
      data,
      headers: response.headers,
    };
  }

  // Convenience methods
  async get<T>(path: string) {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body });
  }

  async put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body });
  }

  async patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, { body });
  }

  async delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

// Singleton instance
export const api = new ApiClient();

// Type definitions for API responses
export interface User {
  id: string;
  authSub: string;
  displayName: string | null;
  identityPubkey: string;
  createdAt: string;
}

export interface Album {
  id: string;
  ownerId: string;
  currentEpochId: number | null;
  currentVersion: number;
  createdAt: string;
  role?: string;
}

export interface AlbumMember {
  userId: string;
  role: string;
  displayName: string | null;
  identityPubkey: string;
  grantedAt: string;
}

export interface EpochKey {
  epochId: number;
  wrappedKey: string;
  wrappedFor: string;
  createdAt: string;
}

export interface Manifest {
  id: string;
  version: number;
  signedPayload: string;
  signerPubkey: string;
  createdAt: string;
  trashedAt: string | null;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
}
