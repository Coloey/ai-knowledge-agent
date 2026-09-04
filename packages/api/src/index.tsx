import React, { createContext, useContext, useMemo } from 'react';

export interface ApiClientOptions {
  baseURL: string;
  token?: string;
}

export interface ApiResponse<T> {
  code: number;
  data: T;
  msg: string;
  detail?: unknown;
}

export interface SendMessagePayload {
  session_id?: string;
  request_id?: string;
  workspace_id: string;
  message: string;
  timezone_offset?: number;
  display_language?: string;
  options?: Record<string, unknown>;
}

export interface AuthUser {
  uid: string;
  email: string;
  name: string;
  avatar: string;
}

export interface AuthResult {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
  default_workspace_id: string;
}

export interface WorkspaceDTO {
  workspace_id: string;
  name: string;
  role: string;
  owner_id: string;
}

export interface LibraryFileDTO {
  file_id: string;
  workspace_id: string;
  title: string;
  file_type: string;
  size: number;
  parse_status: string;
  error_message: string;
}

export class AuthExpiredError extends Error {
  constructor(message = 'Login expired, please login again') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.options.baseURL}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as ApiResponse<T>;
    if (response.status === 401) {
      throw new AuthExpiredError(extractErrorMessage(payload, 'Unauthorized'));
    }
    if (!response.ok || payload.code !== 0) {
      throw new Error(extractErrorMessage(payload, response.statusText));
    }
    return payload.data;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.options.baseURL}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    const payload = (await response.json()) as ApiResponse<T>;
    if (response.status === 401) {
      throw new AuthExpiredError(extractErrorMessage(payload, 'Unauthorized'));
    }
    if (!response.ok || payload.code !== 0) {
      throw new Error(extractErrorMessage(payload, response.statusText));
    }
    return payload.data;
  }

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const response = await fetch(`${this.options.baseURL}${path}`, {
      method: 'POST',
      headers: {
        ...(this.options.token
          ? { Authorization: `Bearer ${this.options.token}` }
          : {}),
      },
      body: formData,
    });
    const payload = (await response.json()) as ApiResponse<T>;
    if (response.status === 401) {
      throw new AuthExpiredError(extractErrorMessage(payload, 'Unauthorized'));
    }
    if (!response.ok || payload.code !== 0) {
      throw new Error(extractErrorMessage(payload, response.statusText));
    }
    return payload.data;
  }

  stream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.options.baseURL}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private headers(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(this.options.token
        ? { Authorization: `Bearer ${this.options.token}` }
        : {}),
    };
  }
}

function extractErrorMessage(payload: ApiResponse<unknown>, fallback: string) {
  if (payload.msg) return payload.msg;
  if (Array.isArray(payload.detail) && payload.detail[0]?.msg) {
    const field = Array.isArray(payload.detail[0].loc)
      ? payload.detail[0].loc
          .filter((part: string) => part !== 'body')
          .join('.')
      : '';
    return field ? `${field}: ${payload.detail[0].msg}` : payload.detail[0].msg;
  }
  return fallback;
}

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider(props: React.PropsWithChildren<ApiClientOptions>) {
  const client = useMemo(
    () =>
      new ApiClient({
        baseURL: props.baseURL,
        ...(props.token ? { token: props.token } : {}),
      }),
    [props.baseURL, props.token],
  );
  return (
    <ApiContext.Provider value={client}>{props.children}</ApiContext.Provider>
  );
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error('ApiProvider is missing');
  }
  return client;
}
