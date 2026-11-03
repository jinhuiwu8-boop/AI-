import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../shared/errors.mjs';

const clone = value => structuredClone(value);
const fail = (code, message, status = 400) => { throw new DomainError(code, message, status); };
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const possibleSubmission = ['SUBMIT_INTENT', 'SPOOLER_ACCEPTED', 'UNCERTAIN'];
const retryable = ['PAPER_NOT_PRINTED', 'FAILED_BEFORE_SPOOL'];
const boss = actor => { if (actor?.role !== 'boss' || actor.active !== true) fail('FORBIDDEN', '仅当前授权老板可操作', 403); };
function text(value, field, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail('INVALID_INPUT', `${field}无效`);
  return value.trim();
}
function equalHash(raw, digest) {
  return typeof raw === 'string' && raw.length <= 512 && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
    && timingSafeEqual(Buffer.from(hash(raw), 'hex'), Buffer.from(digest, 'hex'));
}
function publicAttempt(attempt) {
  const { leaseTokenHash, receiptSignature, ...value } = attempt;
  return clone(value);
}
function documentMetadata(value) {
  if (!value || value.mimeType !== 'application/pdf' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !['UNVALIDATED', 'VALIDATED'].includes(value.calibrationStatus) || value.widthMm !== 130 || value.heightMm !== 190) {
    fail('PRINT_DOCUMENT_FAILED', '套打PDF持久保存回执无效', 503);
  }
  const id = text(value.id, 'document.id');
  const relativePath = text(value.relativePath, 'document.relativePath', 2000);
  if (relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes(':')
    || relativePath.split('/').some(part => !part || part === '.' || part === '..')) fail('PRINT_DOCUMENT_FAILED', 'PDF路径不受控', 503);
  return {
    id, mimeType: 'application/pdf', sha256: value.sha256, relativePath,
    createdAt: text(value.createdAt, 'document.createdAt'),
    templateId: text(value.templateId, 'document.templateId'),
    calibrationStatus: value.calibrationStatus, widthMm: 130, heightMm: 190,
  };
}

export function createPrintService({ store, documentStore, now = () => new Date().toISOString(), authenticateDevice, leaseSeconds = 120 }) {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) fail('INVALID_LEASE_CONFIG', '打印运输租约须为正整数秒');
  function time() {
    const date = new Date(now());
    if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', '时间无效');
    return date;
  }
  function inOrder(state, id) {
    const order = state.orders.find(value => value.id === id);
    if (!order || order.type !== 'SALE') fail('INVALID_PRINT_ORDER', '只可打印已确认销售单', 409);
    return order;
  }
  function inAttempt(state, id) {
    const attempt = state.printAttempts.find(value => value.id === id);
    if (!attempt) fail('PRINT_NOT_FOUND', '打印尝试不存在', 404);
    return attempt;
  }
  function deviceIn(state, context) {
    if (authenticateDevice) authenticateDevice(context);
    const device = state.edgeDevices.find(value => value.id === context?.deviceId);
    if (!device || device.active !== true || !device.capabilities?.includes('PRINT') || !equalHash(context?.token, device.tokenHash)) {
      fail('DEVICE_FORBIDDEN', '打印设备未授权、已撤销或能力不符', 403);
    }
    return device;
  }
  function snapshot(order, revision) {
    const frozen = order.revisions?.find(value => value.revision === revision);
    if (!frozen || frozen.id !== order.id || frozen.type !== 'SALE') fail('ORDER_SNAPSHOT_MISSING', '缺少对应冻结销售版本', 409);
    return clone(frozen);
  }
  function materialize(attempt, order) {
    if (attempt.document?.mimeType === 'application/pdf') {
      attempt.document = documentMetadata(attempt.document);
      attempt.documentId = attempt.document.id; attempt.documentSha256 = attempt.document.sha256;
      return;
    }
    if (attempt.status !== 'PENDING_DEVICE') fail('PRINT_DOCUMENT_REQUIRED', '已有提交风险的旧任务不能补造或覆盖文档', 409);
    const frozen = snapshot(order, attempt.revision);
    let metadata;
    try { metadata = documentMetadata(documentStore.savePaper(frozen)); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      fail('PRINT_DOCUMENT_FAILED', '套打PDF保存失败，未完成本次排队', 503);
    }
    attempt.document = metadata; attempt.snapshotSha256 = hash(canonical(frozen));
    attempt.calibrationStatus = metadata.calibrationStatus;
    attempt.documentId = metadata.id; attempt.documentSha256 = metadata.sha256;
  }
  function write(type, command, actor, perform, legacyOrderId) {
    boss(actor);
    const signature = hash(canonical({ type, command, actorId: actor.id ?? 'boss' }));
    return store.transact(state => {
      const previous = state.operations[command.operationId];
      if (previous) {
        const legacy = legacyOrderId && hash(JSON.stringify({ type: 'QUEUE_PRINT', orderId: legacyOrderId }));
        if (legacy && previous.signature === legacy) {
          fail('LEGACY_PRINT_OPERATION', '此操作属于旧版排队记录；请刷新后用新操作编号补齐原任务，不会重复排队', 409);
        }
        if (previous.signature !== signature) fail('IDEMPOTENCY_CONFLICT', '同操作ID不能改变内容或操作人', 409);
        return clone(previous.result);
      }
      const result = perform(state);
      state.operations[command.operationId] = { signature, result: clone(result) };
      return result;
    });
  }
  function expired(attempt, at) {
    return attempt.status === 'SUBMIT_INTENT'
      && (!Number.isFinite(Date.parse(attempt.leaseUntil)) || Date.parse(attempt.leaseUntil) <= at.getTime());
  }
  function markExpired(attempt, at) {
    if (!expired(attempt, at)) return false;
    attempt.status = 'UNCERTAIN'; attempt.uncertainAt = at.toISOString();
    attempt.uncertainReason = 'PRINT_LEASE_EXPIRED';
    return true;
  }
  function activeLease(attempt, input, context, at) {
    if (input.deviceId !== undefined && input.deviceId !== context.deviceId) fail('DEVICE_FORBIDDEN', '打印回执设备身份不一致', 403);
    if (attempt.status !== 'SUBMIT_INTENT' || attempt.deviceId !== context.deviceId
      || !equalHash(input.leaseToken, attempt.leaseTokenHash)
      || !Number.isFinite(Date.parse(attempt.leaseUntil)) || Date.parse(attempt.leaseUntil) <= at.getTime()) {
      fail('PRINT_LEASE_CONFLICT', '打印运输租约已失效；请人工检查出纸，不能自动重排', 409);
    }
    if (attempt.document?.calibrationStatus !== 'VALIDATED') fail('CALIBRATION_REQUIRED', '套打坐标尚未现场校准，不可提交实际打印', 409);
  }
  return {
    queue(input, actor) {
      const command = { operationId: text(input?.operationId, 'operationId'), orderId: text(input?.orderId, 'orderId') };
      return write('PRINT_QUEUE', command, actor, state => {
        const order = inOrder(state, command.orderId);
        const attempts = state.printAttempts.filter(value => value.orderId === order.id);
        if (attempts.some(value => value.revision !== order.revision && possibleSubmission.includes(value.status))) {
          fail('PRINT_REVIEW_REQUIRED', '旧版本可能已提交打印，请先人工确认出纸，再处理修正版本', 409);
        }
        const existing = attempts.filter(value => value.revision === order.revision && value.status !== 'SUPERSEDED').at(-1);
        if (existing) {
          if (existing.document?.mimeType === 'application/pdf' || existing.status !== 'PENDING_DEVICE') {
            fail(['PENDING_DEVICE', ...possibleSubmission].includes(existing.status) ? 'PRINT_PENDING' : 'INVALID_PRINT_STATE',
              '此版本已有打印尝试，请处理原任务；未出纸须使用明确补打入口', 409);
          }
          existing.copies = 1;
          materialize(existing, order);
          return publicAttempt(existing);
        }
        // Only attempts never handed to a device can be superseded silently.
        for (const old of attempts) if (old.status === 'PENDING_DEVICE') {
          old.status = 'SUPERSEDED'; old.supersededAt = time().toISOString();
          old.supersededByRevision = order.revision;
        }
        const attempt = { id: randomUUID(), orderId: order.id, revision: order.revision,
          status: 'PENDING_DEVICE', copies: 1, createdAt: time().toISOString() };
        materialize(attempt, order); state.printAttempts.push(attempt);
        return publicAttempt(attempt);
      }, command.orderId);
    },
    list() { return store.read().printAttempts.map(publicAttempt); },
    claimPrint(credentials) {
      return store.transact(state => {
        const device = deviceIn(state, credentials), at = time();
        for (const attempt of state.printAttempts) markExpired(attempt, at);
        const pending = state.printAttempts.filter(value => value.status === 'PENDING_DEVICE');
        const attempt = pending.find(value => value.document?.calibrationStatus === 'VALIDATED'
          && state.orders.some(order => order.id === value.orderId && order.type === 'SALE' && order.revision === value.revision)
          && !state.printAttempts.some(other => other.orderId === value.orderId && other.id !== value.id && possibleSubmission.includes(other.status)));
        if (!attempt) return { attempt: null, ...(pending.some(value => value.document?.calibrationStatus === 'UNVALIDATED') ? { reason: 'CALIBRATION_REQUIRED' } : {}) };
        const leaseToken = randomBytes(32).toString('base64url');
        const until = new Date(at.getTime() + leaseSeconds * 1000);
        if (!Number.isFinite(until.getTime())) fail('INVALID_LEASE_CONFIG', '打印运输租约超出有效时间');
        attempt.status = 'SUBMIT_INTENT'; attempt.deviceId = device.id;
        attempt.leaseTokenHash = hash(leaseToken); attempt.leaseUntil = until.toISOString();
        attempt.claimedAt = at.toISOString();
        return { attempt: publicAttempt(attempt), leaseToken, leaseUntil: attempt.leaseUntil };
      });
    },
    readableAttempt(input) {
      const state = store.read(); deviceIn(state, input);
      const attempt = inAttempt(state, text(input?.attemptId, 'attemptId'));
      activeLease(attempt, input, input, time());
      return publicAttempt(attempt);
    },
    markSubmitted(input, deviceContext) {
      const command = {
        operationId: text(input?.operationId, 'operationId'), attemptId: text(input?.attemptId, 'attemptId'),
        outcome: input?.outcome,
        ...(input?.queueId === undefined ? {} : { queueId: text(input.queueId, 'queueId') }),
      };
      if (!['SPOOLER_ACCEPTED', 'UNCERTAIN', 'FAILED_BEFORE_SPOOL'].includes(command.outcome)) fail('INVALID_SUBMISSION', '设备提交结果无效');
      if (command.outcome === 'SPOOLER_ACCEPTED' && !command.queueId) fail('INVALID_SUBMISSION', '提交成功必须提供真实打印队列编号；无法确定时应回报结果未知');
      if (command.outcome === 'FAILED_BEFORE_SPOOL' && command.queueId) fail('INVALID_SUBMISSION', '已存在打印队列编号不能声明提交前失败');
      return store.transact(state => {
        const device = deviceIn(state, deviceContext);
        if (input.deviceId !== undefined && input.deviceId !== device.id) fail('DEVICE_FORBIDDEN', '打印回执设备身份不一致', 403);
        const signature = hash(canonical({ type: 'PRINT_RECEIPT', command, deviceId: device.id }));
        const attempt = inAttempt(state, command.attemptId);
        // Even a known idempotency key needs proof of its original lease.
        if (attempt.deviceId !== device.id || !equalHash(input.leaseToken, attempt.leaseTokenHash)) fail('PRINT_LEASE_CONFLICT', '回执不属于此打印租约', 409);
        const previous = state.operations[command.operationId];
        if (previous) {
          if (previous.signature !== signature) fail('IDEMPOTENCY_CONFLICT', '同回执操作ID不能改变内容或设备', 409);
          return clone(previous.result);
        }
        if (attempt.receiptSignature) {
          const receipt = hash(canonical({ attemptId: command.attemptId, outcome: command.outcome, queueId: command.queueId ?? null, deviceId: device.id }));
          if (receipt !== attempt.receiptSignature) fail('PRINT_RECEIPT_CONFLICT', '同打印尝试不能被不同回执覆盖', 409);
          const result = publicAttempt(attempt);
          state.operations[command.operationId] = { signature, result: clone(result) };
          return result;
        }
        activeLease(attempt, input, deviceContext, time());
        attempt.status = command.outcome; attempt.submittedAt = time().toISOString();
        if (command.queueId) attempt.queueId = command.queueId;
        attempt.receiptSignature = hash(canonical({ attemptId: command.attemptId, outcome: command.outcome, queueId: command.queueId ?? null, deviceId: device.id }));
        const result = publicAttempt(attempt);
        state.operations[command.operationId] = { signature, result: clone(result) };
        return result;
      });
    },
    confirmPaper(input, actor) {
      const command = { operationId: text(input?.operationId, 'operationId'), attemptId: text(input?.attemptId, 'attemptId'), printed: input?.printed };
      if (typeof command.printed !== 'boolean') fail('INVALID_PAPER_RESULT', '请明确确认出纸或未出纸');
      return write('PRINT_CONFIRM_PAPER', command, actor, state => {
        const attempt = inAttempt(state, command.attemptId), at = time();
        markExpired(attempt, at);
        if (!['SPOOLER_ACCEPTED', 'UNCERTAIN'].includes(attempt.status)) fail('INVALID_PRINT_STATE', '只能对已提交或结果未知的任务人工确认出纸', 409);
        attempt.status = command.printed ? 'PAPER_CONFIRMED' : 'PAPER_NOT_PRINTED';
        attempt.paperConfirmedAt = at.toISOString(); attempt.paperConfirmedBy = actor.id ?? 'boss';
        attempt.paperPrinted = command.printed;
        return publicAttempt(attempt);
      });
    },
    reprint(input, actor) {
      const command = { operationId: text(input?.operationId, 'operationId'), attemptId: text(input?.attemptId, 'attemptId') };
      return write('PRINT_REPRINT', command, actor, state => {
        const original = inAttempt(state, command.attemptId);
        if (!retryable.includes(original.status)) fail('INVALID_PRINT_STATE', '须人工确认未出纸，或设备明确提交前失败，才能补打一份', 409);
        const order = inOrder(state, original.orderId);
        if (order.revision !== original.revision) fail('ORDER_VERSION_CONFLICT', '原打印版本已被更正，请处理最新版本，不能补打过期单据', 409);
        if (!original.document) fail('PRINT_DOCUMENT_REQUIRED', '原任务没有冻结PDF，不可猜测重建后补打', 409);
        const child = state.printAttempts.find(value => value.reprintOf === original.id);
        if (child) return publicAttempt(child);
        if (state.printAttempts.some(value => value.orderId === order.id && value.id !== original.id
          && ['PENDING_DEVICE', ...possibleSubmission].includes(value.status))) fail('PRINT_REVIEW_REQUIRED', '同单已有待处理打印尝试，请先处理该尝试', 409);
        const attempt = { id: randomUUID(), orderId: original.orderId, revision: original.revision,
          status: 'PENDING_DEVICE', copies: 1, createdAt: time().toISOString(),
          reprintOf: original.id, rootAttemptId: original.rootAttemptId ?? original.id,
          document: clone(original.document), snapshotSha256: original.snapshotSha256,
          documentId: original.document.id, documentSha256: original.document.sha256,
          calibrationStatus: original.document.calibrationStatus };
        state.printAttempts.push(attempt);
        return publicAttempt(attempt);
      });
    },
    expireClaims() {
      return store.transact(state => {
        const at = time(), attemptIds = [];
        for (const attempt of state.printAttempts) if (markExpired(attempt, at)) attemptIds.push(attempt.id);
        return { uncertainCount: attemptIds.length, attemptIds };
      });
    },
  };
}
