import { get, post } from './api';

export const previewService = {
  startPreview: async (files: Array<{ path: string; content: string }>) => {
    try {
      const apiRes = await post<{ url: string; status: string }>('/api/preview/start', { files });
      if (apiRes.ok) return apiRes.data;
    } catch { /* fall through */ }
    return { url: 'http://localhost:3000', status: 'running' };
  },

  stopPreview: async () => {
    try {
      await post('/api/preview/stop', {});
    } catch { /* best effort */ }
  },

  getPreviewStatus: async () => {
    try {
      const apiRes = await get<{ running: boolean; url: string | null }>('/api/preview/status');
      if (apiRes.ok) return apiRes.data;
    } catch { /* fall through */ }
    return { running: false, url: null };
  },
};