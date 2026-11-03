import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../shared/errors.mjs';

const fail = (code, message, status = 400) => { throw new DomainError(code, message, status); };
const copy = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (key, item) => plain(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const token = () => randomBytes(32).toString('base64url');
const capabilities = ['INFER', 'PRINT'];

function text(value, field, max = 200, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    fail('INVALID_INPUT', `${field}必须是${max}字符以内的文本`);
  }
  return value.trim();
}
function keys(value, allowed, code = 'INVALID_INPUT') {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail(code, '仅接受合同中定义的字段');
  }
}
function boss(actor) {
  if (actor?.role !== 'boss' || actor.active !== true) fail('FORBIDDEN', '仅当前授权老板可操作', 403);
}
function safeDevice(device) {
  return {
    id: device.id, name: device.name, capabilities: [...device.capabilities],
    active: device.active, createdAt: device.createdAt,
    ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
  };
}
function matchesHash(raw, digest) {
  if (typeof raw !== 'string' || raw.length > 512 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(Buffer.from(sha256(raw), 'hex'), Buffer.from(digest, 'hex'));
}
function authenticateIn(state, credentials, capability) {
  if (!capabilities.includes(capability)) fail('INVALID_CAPABILITY', '设备能力无效');
  const device = state.edgeDevices.find(item => item.id === credentials?.deviceId);
  if (!device || device.active !== true || !matchesHash(credentials?.token, device.tokenHash)
    || !device.capabilities.includes(capability)) {
    fail('DEVICE_FORBIDDEN', '设备未授权、已撤销或能力不匹配', 403);
  }
  return device;
}

// Candidate data is deliberately incapable of carrying authoritative prices,
// sale totals, master-data creation commands or a confirmation flag.
function normalizeCandidate(state, value, validateMasters = true) {
  keys(value, ['customerId', 'items', 'issues'], 'UNCONTROLLED_RESULT');
  if (value.customerId !== null) {
    const id = text(value.customerId, 'customerId');
    if (validateMasters && !state.customers.some(item => item.id === id)) fail('UNKNOWN_CUSTOMER', '识别客户不在现有主档中');
  }
  if (!Array.isArray(value.items) || value.items.length > 100) fail('INVALID_ITEMS', '识别明细最多100行');
  if (!Array.isArray(value.issues) || value.issues.length > 100) fail('INVALID_ISSUES', '识别问题最多100项');
  const items = value.items.map(row => {
    keys(row, ['skuId', 'productName', 'unit', 'quantity'], 'UNCONTROLLED_RESULT');
    let product = null;
    const skuId = row.skuId === null ? null : text(row.skuId, 'skuId');
    if (skuId !== null && validateMasters) {
      product = state.products.find(item => item.id === skuId);
      if (!product) fail('UNKNOWN_PRODUCT', '识别商品不在现有主档中');
    }
    const unit = row.unit === null ? null : text(row.unit, 'unit', 20);
    if (unit !== null && (!['箱', '瓶'].includes(unit) || (product && !product.units.includes(unit)))) {
      fail('INVALID_UNIT', '识别单位无效或不属于该商品');
    }
    if (row.quantity !== null && (!Number.isSafeInteger(row.quantity) || row.quantity <= 0)) {
      fail('INVALID_QUANTITY', '识别数量须为正安全整数或待人工补充');
    }
    return {
      skuId,
      ...(row.productName === undefined ? {} : { productName: text(row.productName, 'productName', 300) }),
      unit, quantity: row.quantity,
    };
  });
  return {
    customerId: value.customerId === null ? null : value.customerId.trim(),
    items, issues: value.issues.map(issue => text(issue, 'issue', 500)),
  };
}

function controlledMedia(media) {
  keys(media, ['id', 'mimeType', 'sizeBytes', 'sha256', 'relativePath'], 'JOB_DATA_INVALID');
  const result = { id: text(media.id, 'media.id', 2000) };
  if (media.mimeType !== undefined) result.mimeType = text(media.mimeType, 'media.mimeType', 2000);
  if (media.sizeBytes !== undefined) {
    if (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes <= 0) fail('JOB_DATA_INVALID', '持久媒体大小无效', 409);
    result.sizeBytes = media.sizeBytes;
  }
  if (media.sha256 !== undefined) {
    if (typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(media.sha256)) fail('JOB_DATA_INVALID', '持久媒体摘要无效', 409);
    result.sha256 = media.sha256.toLowerCase();
  }
  if (media.relativePath !== undefined) {
    const path = text(media.relativePath, 'media.relativePath', 2000);
    if (path.includes('\\') || path.includes(':') || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..')) {
      fail('JOB_DATA_INVALID', '持久媒体路径不受控', 409);
    }
    result.relativePath = path;
  }
  return result;
}

function controlledJob(state, job) {
  const batch = state.batches.find(item => item.id === job.batchId);
  if (!batch || batch.status !== 'SEALED' || batch.version !== job.batchVersion
    || batch.sourceId !== job.sourceId || batch.conversationId !== job.conversationId
    || !Array.isArray(job.messageIds) || !Array.isArray(batch.messageIds)) {
    fail('JOB_DATA_INVALID', '识别任务与封单批次不一致', 409);
  }
  const messages = job.messageIds.map(id => {
    if (!batch.messageIds.includes(id)) fail('JOB_DATA_INVALID', '任务消息不属于当前批次', 409);
    const found = state.messages.find(message => message.messageId === id
      && message.sourceId === job.sourceId && message.conversationId === job.conversationId
      && message.result?.batchId === batch.id);
    if (!found || !['TEXT', 'IMAGE', 'VOICE'].includes(found.type)
      || !['customer', 'product'].includes(found.kind) || !Array.isArray(found.media)) {
      fail('JOB_DATA_INVALID', '任务消息缺失或归属不一致', 409);
    }
    return {
      messageId: found.messageId, type: found.type, kind: found.kind,
      text: text(found.text ?? '', 'message.text', 2000, true),
      customerHint: text(found.customerHint ?? '', 'message.customerHint', 2000, true),
      media: found.media.map(controlledMedia), receivedAt: found.receivedAt,
    };
  });
  return {
    id: job.id, type: 'INFER', batchId: job.batchId, batchVersion: job.batchVersion,
    sourceId: job.sourceId, conversationId: job.conversationId,
    customerHint: text(job.customerHint ?? '', 'job.customerHint', 2000, true),
    status: job.status, createdAt: job.createdAt, attempt: job.attempt, messages,
  };
}

export function createEdgeService({ store, now = () => new Date().toISOString(), leaseSeconds = 120 }) {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) fail('INVALID_LEASE_CONFIG', '识别租约秒数须为正安全整数');
  function time() {
    const at = new Date(now());
    if (!Number.isFinite(at.getTime())) fail('INVALID_CLOCK', '时间无效');
    return at;
  }
  function deadline(at) {
    const until = new Date(at.getTime() + leaseSeconds * 1000);
    if (!Number.isFinite(until.getTime())) fail('INVALID_LEASE_CONFIG', '识别租约超出有效时间范围');
    return until.toISOString();
  }
  function write(type, input, actor, perform) {
    boss(actor);
    const operationId = text(input.operationId, 'operationId');
    const signature = sha256(canonical({ type, input, actorId: actor.id ?? 'boss' }));
    return store.transact(state => {
      const previous = state.operations[operationId];
      if (previous) {
        if (previous.signature !== signature) fail('IDEMPOTENCY_CONFLICT', '同操作ID不能改变内容或操作人', 409);
        return perform(state, previous);
      }
      return perform(state, null, signature);
    });
  }
  function leasedJob(state, input, at) {
    const jobId = text(input.jobId, 'jobId');
    const job = state.edgeJobs.find(item => item.id === jobId);
    if (!job) fail('JOB_NOT_FOUND', '识别任务不存在', 404);
    if (job.status !== 'INFER_RUNNING' || job.leaseDeviceId !== input.deviceId
      || !matchesHash(input.leaseToken, job.leaseTokenHash)
      || !Number.isFinite(Date.parse(job.leaseUntil)) || Date.parse(job.leaseUntil) <= at.getTime()) {
      fail('LEASE_CONFLICT', '识别租约无效、过期或已被替换', 409);
    }
    return job;
  }
  return {
    registerDevice(input, actor) {
      keys(input, ['operationId', 'name', 'capabilities']);
      const command = { operationId: text(input.operationId, 'operationId'), name: text(input.name, 'name'), capabilities: [] };
      if (!Array.isArray(input.capabilities) || !input.capabilities.length
        || input.capabilities.some(item => !capabilities.includes(item))) fail('INVALID_CAPABILITY', '至少选择一个有效设备能力');
      command.capabilities = [...new Set(input.capabilities)].sort();
      return write('EDGE_REGISTER_DEVICE', command, actor, (state, previous, signature) => {
        if (previous) {
          const device = state.edgeDevices.find(item => item.id === previous.result.deviceId);
          if (!device) fail('DEVICE_NOT_FOUND', '原登记设备不存在', 409);
          return { device: safeDevice(device), token: null, tokenAvailable: false, duplicate: true,
            message: '完整令牌仅首次登记返回，无法再次读取；若未保存，请撤销此设备并重新登记。' };
        }
        const raw = token();
        const device = { id: randomUUID(), name: command.name, capabilities: command.capabilities,
          active: true, createdAt: time().toISOString(), tokenHash: sha256(raw) };
        state.edgeDevices.push(device);
        state.operations[command.operationId] = { signature, result: { deviceId: device.id } };
        return { device: safeDevice(device), token: raw, tokenAvailable: true, duplicate: false };
      });
    },
    listDevices() { return store.read().edgeDevices.map(safeDevice); },
    revokeDevice(input, actor) {
      keys(input, ['operationId', 'deviceId']);
      const command = { operationId: text(input.operationId, 'operationId'), deviceId: text(input.deviceId, 'deviceId') };
      return write('EDGE_REVOKE_DEVICE', command, actor, (state, previous, signature) => {
        if (previous) return copy(previous.result);
        const device = state.edgeDevices.find(item => item.id === command.deviceId);
        if (!device) fail('DEVICE_NOT_FOUND', '设备不存在', 404);
        if (device.active) { device.active = false; device.revokedAt = time().toISOString(); }
        const result = { device: safeDevice(device) };
        state.operations[command.operationId] = { signature, result: copy(result) };
        return result;
      });
    },
    authenticate(credentials, capability) {
      const device = authenticateIn(store.read(), credentials, capability);
      return { deviceId: device.id, capabilities: [...device.capabilities] };
    },
    claimInference(credentials) {
      return store.transact(state => {
        const device = authenticateIn(state, credentials, 'INFER');
        const at = time();
        const job = state.edgeJobs.find(item => (!item.type || item.type === 'INFER')
          && (item.status === 'WAITING_EDGE' || (item.status === 'INFER_RUNNING'
            && Number.isFinite(Date.parse(item.leaseUntil)) && Date.parse(item.leaseUntil) <= at.getTime())));
        if (!job) return { job: null };
        const raw = token();
        job.status = 'INFER_RUNNING'; job.leaseDeviceId = device.id;
        job.leaseTokenHash = sha256(raw); job.leaseUntil = deadline(at);
        job.claimedAt = at.toISOString(); job.attempt = (job.attempt ?? 0) + 1;
        return { job: controlledJob(state, job), leaseToken: raw, leaseUntil: job.leaseUntil };
      });
    },
    renewInference(input) {
      return store.transact(state => {
        authenticateIn(state, input, 'INFER');
        const at = time();
        const job = leasedJob(state, input, at);
        job.leaseUntil = deadline(at); job.renewedAt = at.toISOString();
        return { jobId: job.id, status: job.status, leaseUntil: job.leaseUntil };
      });
    },
    completeInference(input) {
      return store.transact(state => {
        authenticateIn(state, input, 'INFER');
        const job = state.edgeJobs.find(item => item.id === input.jobId);
        if (!job) fail('JOB_NOT_FOUND', '识别任务不存在', 404);
        // An acknowledged completion can be replayed even after review, but it
        // can never mutate the candidate, lease, review link or sale state.
        if (job.completion) {
          if (job.completedDeviceId !== input.deviceId || !matchesHash(input.leaseToken, job.completedLeaseTokenHash)) {
            fail('LEASE_CONFLICT', '此租约不属于已完成结果', 409);
          }
          // Compare to the accepted frozen result. A later product packaging
          // edit must not retroactively invalidate a successful acknowledgement.
          const resultSha256 = sha256(canonical(normalizeCandidate(state, input.result, false)));
          if (job.resultSha256 !== resultSha256) fail('RESULT_CONFLICT', '已完成任务不能提交不同识别结果', 409);
          return copy(job.completion);
        }
        const candidate = normalizeCandidate(state, input.result);
        const resultSha256 = sha256(canonical(candidate));
        const at = time();
        leasedJob(state, input, at);
        job.candidate = candidate; job.resultSha256 = resultSha256;
        job.candidateVersion = `inference:${randomUUID()}`;
        job.status = 'AWAITING_REVIEW'; job.completedAt = at.toISOString();
        job.completedDeviceId = input.deviceId; job.completedLeaseTokenHash = job.leaseTokenHash;
        delete job.leaseTokenHash; delete job.leaseUntil;
        job.completion = { jobId: job.id, status: job.status, candidate: copy(candidate),
          candidateVersion: job.candidateVersion, resultSha256, completedAt: job.completedAt };
        return copy(job.completion);
      });
    },
  };
}
