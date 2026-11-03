import { randomUUID } from 'node:crypto';
import { DomainError } from '../shared/errors.mjs';

const fail = (code, message, status = 400) => { throw new DomainError(code, message, status); };
const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, field, required = true) {
  if (typeof value !== 'string' || value.length > 2000 || (required && !value.trim())) fail('INVALID_MESSAGE', `${field}无效`);
  return value.trim();
}
function normalize(input) {
  if (!plain(input)) fail('INVALID_MESSAGE', '消息必须是对象');
  const result = {};
  for (const key of ['sourceId', 'conversationId', 'messageId']) result[key] = string(input[key], key);
  if (!['TEXT', 'IMAGE', 'VOICE'].includes(input.type) || !['customer', 'product', 'unassigned'].includes(input.kind)) fail('INVALID_MESSAGE', '消息类型或归属无效');
  Object.assign(result, { type: input.type, kind: input.kind, text: string(input.text ?? '', 'text', false), customerHint: string(input.customerHint ?? '', 'customerHint', false), media: [] });
  if (!Array.isArray(input.media ?? [])) fail('INVALID_MEDIA', '媒体必须是数组');
  for (const item of input.media ?? []) {
    if (!plain(item) || Object.keys(item).some(key => !['id', 'mimeType', 'sizeBytes', 'sha256', 'relativePath'].includes(key))) fail('INVALID_MEDIA', '仅接受受控媒体元数据');
    const media = { id: string(item.id, 'media.id') };
    if (item.mimeType !== undefined) media.mimeType = string(item.mimeType, 'mimeType');
    if (item.sizeBytes !== undefined) {
      if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) fail('INVALID_MEDIA', '媒体大小无效');
      media.sizeBytes = item.sizeBytes;
    }
    if (item.sha256 !== undefined) {
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) fail('INVALID_MEDIA', '媒体摘要无效');
      media.sha256 = item.sha256.toLowerCase();
    }
    if (item.relativePath !== undefined) {
      const path = string(item.relativePath, 'relativePath');
      if (path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_MEDIA', '媒体路径必须受控且相对');
      media.relativePath = path;
    }
    result.media.push(media);
  }
  if (result.type !== 'TEXT' && !result.media.length) fail('MEDIA_REQUIRED', '图片或语音缺少媒体引用');
  if (result.type === 'TEXT' && !result.text) fail('INVALID_MESSAGE', '文字消息不能为空');
  if (result.kind === 'customer' && !result.customerHint) fail('CUSTOMER_REQUIRED', '客户提示不能为空');
  return result;
}

export function createIntakeService({ store, now = () => new Date().toISOString() }) {
  function time() {
    const value = new Date(now());
    if (!Number.isFinite(value.getTime())) fail('INVALID_CLOCK', '时间无效');
    return value;
  }
  function seal(state, batch, at, reason) {
    if (batch.status !== 'OPEN') return null;
    batch.status = 'SEALED';
    batch.closedAt = at;
    batch.closedReason = reason;
    batch.version += 1;
    if (!batch.productCount) return null;
    const previous = state.edgeJobs.find(job => job.batchId === batch.id);
    if (previous) return previous;
    const job = { id: randomUUID(), batchId: batch.id, batchVersion: batch.version, sourceId: batch.sourceId, conversationId: batch.conversationId, customerHint: batch.customerHint, messageIds: [...batch.messageIds], status: 'WAITING_EDGE', createdAt: at };
    state.edgeJobs.push(job);
    batch.jobId = job.id;
    return job;
  }
  return {
    receive(input) {
      const message = normalize(input);
      const canonical = JSON.stringify(message);
      const at = time();
      return store.transact(state => {
        const source = state.sources.find(source => (source.id ?? source.sourceId) === message.sourceId);
        if (!source || source.active !== true) fail('SOURCE_FORBIDDEN', '转单来源未授权或已停用', 403);
        const existing = state.messages.find(item => item.sourceId === message.sourceId && item.conversationId === message.conversationId && item.messageId === message.messageId);
        if (existing) {
          if (existing.canonical !== canonical) fail('MESSAGE_CONFLICT', '同一消息编号内容不同', 409);
          return { ...clone(existing.result), duplicate: true };
        }
        let batch = state.batches.find(item => item.sourceId === message.sourceId && item.conversationId === message.conversationId && item.status === 'OPEN');
        if (batch?.deadline && Date.parse(batch.deadline) <= at.getTime()) {
          seal(state, batch, at.toISOString(), 'SILENCE');
          batch = null;
        }
        if (message.kind === 'customer') {
          if (batch) seal(state, batch, at.toISOString(), 'NEW_CUSTOMER');
          batch = { id: randomUUID(), sourceId: message.sourceId, conversationId: message.conversationId, customerHint: message.customerHint, status: 'OPEN', version: 1, productCount: 0, messageIds: [], deadline: null, createdAt: at.toISOString(), jobId: null };
          state.batches.push(batch);
        }
        const assigned = message.kind !== 'unassigned' && Boolean(batch);
        if (assigned) {
          batch.messageIds.push(message.messageId);
          batch.version += 1;
          if (message.kind === 'product') {
            batch.productCount += 1;
            batch.lastProductAt = at.toISOString();
            batch.deadline = new Date(at.getTime() + 60_000).toISOString();
          }
        }
        const result = { messageId: message.messageId, batchId: assigned ? batch.id : null, status: assigned ? 'BATCHED' : 'UNASSIGNED', duplicate: false };
        state.messages.push({ ...message, canonical, receivedAt: at.toISOString(), result: clone(result) });
        return result;
      });
    },
    sealDue() {
      const at = time();
      return store.transact(state => {
        const sealed = [];
        for (const batch of state.batches) if (batch.status === 'OPEN' && batch.deadline && Date.parse(batch.deadline) <= at.getTime()) {
          const job = seal(state, batch, at.toISOString(), 'SILENCE');
          sealed.push({ batchId: batch.id, jobId: job?.id ?? null });
        }
        return { sealedCount: sealed.length, sealed };
      });
    },
    listBatches() { return clone(store.read().batches); },
    listJobs() { return clone(store.read().edgeJobs); },
  };
}
