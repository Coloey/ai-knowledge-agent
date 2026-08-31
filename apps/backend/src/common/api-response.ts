export interface ApiResponse<T> {
  code: number;
  data: T;
  msg: string;
}

export function ok<T>(data: T, msg = 'ok'): ApiResponse<T> {
  return { code: 0, data, msg };
}

export function fail<T = null>(msg = 'error', code = 1, data: T = null as T): ApiResponse<T> {
  return { code, data, msg };
}
