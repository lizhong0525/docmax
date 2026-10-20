/**
 * 文档库 HTTP 客户端（同源 /api/docs）。
 */
import type {
  AuditEvent,
  AuditEventInput,
  CreateDocInput,
  DocDetail,
  DocHistory,
  DocListResponse,
  DocSummary,
  SaveDocInput,
  SaveDocResponse,
} from '../core/docs';

export class DocApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new DocApiError('offline', '无法连接本地文档库服务。', 0);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应
  }
  if (!response.ok) {
    const error = payload as { code?: string; error?: string } | null;
    throw new DocApiError(error?.code ?? 'http-error', error?.error ?? `文档库请求失败（HTTP ${response.status}）。`, response.status);
  }
  return payload as T;
}

const encodeId = (id: string): string => encodeURIComponent(id);

export const docApi = {
  list(): Promise<DocListResponse> {
    return request<DocListResponse>('/api/docs');
  },

  create(input: CreateDocInput): Promise<{ doc: DocDetail }> {
    return request<{ doc: DocDetail }>('/api/docs', { method: 'POST', body: JSON.stringify(input) });
  },

  get(id: string): Promise<{ doc: DocDetail }> {
    return request<{ doc: DocDetail }>(`/api/docs/${encodeId(id)}`);
  },

  save(id: string, input: SaveDocInput): Promise<SaveDocResponse> {
    return request<SaveDocResponse>(`/api/docs/${encodeId(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  rename(id: string, title: string): Promise<{ doc: DocSummary }> {
    return request<{ doc: DocSummary }>(`/api/docs/${encodeId(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  },

  remove(id: string): Promise<{ ok: boolean; trashedTo: string }> {
    return request<{ ok: boolean; trashedTo: string }>(`/api/docs/${encodeId(id)}`, { method: 'DELETE' });
  },

  history(id: string): Promise<DocHistory> {
    return request<DocHistory>(`/api/docs/${encodeId(id)}/history`);
  },

  revision(id: string, rev: number): Promise<{ rev: number; content: string }> {
    return request<{ rev: number; content: string }>(`/api/docs/${encodeId(id)}/revisions/${rev}`);
  },

  restore(id: string, rev: number): Promise<SaveDocResponse> {
    return request<SaveDocResponse>(`/api/docs/${encodeId(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ rev }),
    });
  },

  audit(id: string, input: AuditEventInput): Promise<{ event: AuditEvent }> {
    return request<{ event: AuditEvent }>(`/api/docs/${encodeId(id)}/audit`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  reveal(id: string): Promise<{ ok: boolean; folder: string }> {
    return request<{ ok: boolean; folder: string }>(`/api/docs/${encodeId(id)}/reveal`, { method: 'POST' });
  },
};
