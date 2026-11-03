import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createStore } from '../../src/shared/store.mjs';
import { createDemoState } from '../../src/shared/seed.mjs';
import { createBusinessService } from '../../src/business/index.mjs';
import { createEdgeService } from '../../src/edge-cloud/index.mjs';
import { createDocumentStore } from '../../src/documents/store.mjs';
import { createPrintService } from '../../src/printing/index.mjs';

const boss = { id: 'printing-test-boss', role: 'boss', active: true };
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (fn, code, status) => assert.throws(fn, value => value.code === code && (!status || value.status === status));
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'printing-test-'));
  return { directory, cleanup() {
    const child = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    rmSync(directory, { recursive: true, force: true });
  } };
}
function setup({ filename = ':memory:', calibration = 'VALIDATED', documentStore, leaseSeconds = 120 } = {}) {
  const store = createStore({ filename, initialState: createDemoState() });
  let clock = Date.parse('2026-10-31T00:00:00.000Z'), documents = 0;
  const now = () => new Date(clock).toISOString();
  const fake = { savePaper(snapshot) {
    documents += 1;
    return { id: randomUUID(), mimeType: 'application/pdf', sha256: digest(JSON.stringify(snapshot)),
      relativePath: `synthetic/${documents}.pdf`, createdAt: now(), templateId: 'synthetic-validated-template',
      calibrationStatus: calibration, widthMm: 130, heightMm: 190 };
  } };
  const electronic = { save: () => ({ id: randomUUID(), mimeType: 'image/png', sha256: 'a'.repeat(64), relativePath: 'synthetic.png', createdAt: now() }) };
  const business = createBusinessService({ store, documentStore: electronic, now });
  const edge = createEdgeService({ store, now });
  const service = createPrintService({ store, documentStore: documentStore ?? fake, now, leaseSeconds,
    authenticateDevice: credentials => edge.authenticate(credentials, 'PRINT') });
  return { store, business, edge, service, now, documentStore: documentStore ?? fake,
    countDocuments: () => documents, advance: milliseconds => { clock += milliseconds; },
    register: (operationId = randomUUID(), capabilities = ['PRINT']) => {
      const registration = edge.registerDevice({ operationId, name: '合成打印设备', capabilities }, boss);
      return { deviceId: registration.device.id, token: registration.token };
    },
  };
}
function sale(env, mode = 'PAPER') {
  const q = env.business.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  return env.business.createSale({ operationId: randomUUID(), customerId: 'C-A', mode, checked: true,
    items: [{ skuId: 'SKU-S', unit: '箱', quantity: 2, priceCents: 10000, priceVersion: q.version, manualPrice: true, zeroConfirmed: false }] }, boss);
}
const receipt = (claim, auth, operationId = randomUUID(), outcome = 'SPOOLER_ACCEPTED') => ({ operationId, attemptId: claim.attempt.id,
  deviceId: auth.deviceId, token: auth.token, leaseToken: claim.leaseToken, outcome,
  ...(outcome === 'FAILED_BEFORE_SPOOL' ? {} : { queueId: 'synthetic-spool-1' }) });
const queue = (env, order, operationId = randomUUID()) => env.service.queue({ operationId, orderId: order.id }, boss);

test('queue补齐W1纸质同attempt，电子单只添打印尝试，重复queue不重复建PDF或计销售', () => {
  const env = setup();
  try {
    const paper = sale(env); const originalId = env.store.read().printAttempts[0].id;
    env.store.transact(state => {
      // W1 queue references could point to an electronic PNG. Enriching that
      // unsubmitted placeholder must replace both legacy and nested identity.
      state.printAttempts[0].documentId = 'legacy-png-id';
      state.printAttempts[0].document = { id: 'legacy-png-id', mimeType: 'image/png' };
      return null;
    });
    const salesBefore = env.store.read().salesEvents;
    const input = { operationId: 'queue-paper', orderId: paper.id };
    const queued = env.service.queue(input, boss);
    assert.equal(queued.id, originalId); assert.equal(queued.copies, 1);
    assert.equal(queued.document.mimeType, 'application/pdf');
    assert.equal(env.countDocuments(), 1); assert.equal(env.service.list().length, 1);
    assert.deepEqual(env.service.queue(input, boss), queued);
    error(() => queue(env, paper), 'PRINT_PENDING', 409); assert.equal(env.countDocuments(), 1);
    assert.equal(queued.documentId, queued.document.id); assert.equal(queued.documentSha256, queued.document.sha256);
    assert.notEqual(queued.documentId, 'legacy-png-id');
    assert.deepEqual(env.store.read().salesEvents, salesBefore);
    const electronic = sale(env, 'ELECTRONIC'), before = env.store.read().salesEvents;
    const electronicPrint = queue(env, electronic);
    assert.equal(electronicPrint.revision, electronic.revision);
    assert.equal(env.countDocuments(), 2); assert.equal(env.service.list().length, 2);
    assert.deepEqual(env.store.read().salesEvents, before);
    error(() => env.service.queue(input, { ...boss, id: 'other-boss' }), 'IDEMPOTENCY_CONFLICT', 409);
    error(() => env.service.queue({ ...input, orderId: electronic.id }, boss), 'IDEMPOTENCY_CONFLICT', 409);
    const copy = env.service.list(); copy[0].document.sha256 = 'changed';
    assert.equal(env.service.list()[0].document.sha256, queued.document.sha256);
  } finally { env.store.close(); }
});

test('PDF生成/保存/非法回执失败时queue原子回滚，原单和旧attempt不部分改变', () => {
  for (const documentStore of [{ savePaper() { throw new Error('synthetic failure'); } }, { savePaper() { return { mimeType: 'application/pdf' }; } }]) {
    const env = setup({ documentStore });
    try {
      const order = sale(env), before = env.store.read();
      error(() => queue(env, order), 'PRINT_DOCUMENT_FAILED', 503);
      assert.deepEqual(env.store.read(), before);
    } finally { env.store.close(); }
  }
});

test('旧QUEUE_PRINT操作明确409且不重排；新operation只补齐同W1任务', () => {
  const env = setup();
  try {
    const order = sale(env); const initial = env.store.read().printAttempts[0];
    env.store.transact(state => {
      state.operations['legacy'] = { signature: digest(JSON.stringify({ type: 'QUEUE_PRINT', orderId: order.id })), result: initial };
      return null;
    });
    const before = env.store.read();
    error(() => queue(env, order, 'legacy'), 'LEGACY_PRINT_OPERATION', 409);
    assert.deepEqual(env.store.read(), before);
    assert.equal(queue(env, order).id, initial.id); assert.equal(env.service.list().length, 1);
  } finally { env.store.close(); }
});

test('仅老板排队/人工确认/补打；PENDING_DEVICE未提交不能假确认已出纸', () => {
  const env = setup();
  try {
    const order = sale(env); const attempt = queue(env, order);
    for (const actor of [undefined, { role: 'boss', active: false }, { role: 'source', active: true }]) {
      error(() => env.service.queue({ operationId: randomUUID(), orderId: order.id }, actor), 'FORBIDDEN', 403);
      error(() => env.service.confirmPaper({ operationId: randomUUID(), attemptId: attempt.id, printed: true }, actor), 'FORBIDDEN', 403);
      error(() => env.service.reprint({ operationId: randomUUID(), attemptId: attempt.id }, actor), 'FORBIDDEN', 403);
    }
    error(() => env.service.confirmPaper({ operationId: 'fake-paper', attemptId: attempt.id, printed: true }, boss), 'INVALID_PRINT_STATE', 409);
    error(() => env.service.reprint({ operationId: 'fake-reprint', attemptId: attempt.id }, boss), 'INVALID_PRINT_STATE', 409);
    error(() => env.service.markSubmitted({ operationId: 'boss-is-not-device', attemptId: attempt.id, deviceId: boss.id, leaseToken: 'none', outcome: 'SPOOLER_ACCEPTED', queueId: 'synthetic' }, boss), 'DEVICE_FORBIDDEN', 403);
    assert.equal(env.service.list()[0].status, 'PENDING_DEVICE');
  } finally { env.store.close(); }
});

test('实际PDF元数据为UNVALIDATED，仅可预览且不可由设备领取或提交', () => {
  const temp = temporary();
  const documents = createDocumentStore({ directory: join(temp.directory, 'documents') });
  const env = setup({ documentStore: documents });
  try {
    const order = sale(env); const attempt = queue(env, order), auth = env.register();
    assert.equal(attempt.document.calibrationStatus, 'UNVALIDATED');
    assert.equal(documents.read(attempt.document.id, 'pdf').subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(env.service.claimPrint(auth), { attempt: null, reason: 'CALIBRATION_REQUIRED' });
    // Even a corrupted/migrated lease cannot bypass the explicit calibration gate.
    env.store.transact(state => {
      Object.assign(state.printAttempts[0], { status: 'SUBMIT_INTENT', deviceId: auth.deviceId,
        leaseTokenHash: digest('synthetic-lease'), leaseUntil: '2026-10-31T00:02:00.000Z' });
      return null;
    });
    const input = { operationId: 'unsafe-submit', attemptId: attempt.id, deviceId: auth.deviceId, leaseToken: 'synthetic-lease', outcome: 'SPOOLER_ACCEPTED', queueId: 'synthetic' };
    error(() => env.service.markSubmitted(input, auth), 'CALIBRATION_REQUIRED', 409);
    error(() => env.service.readableAttempt({ ...auth, attemptId: attempt.id, leaseToken: 'synthetic-lease' }), 'CALIBRATION_REQUIRED', 409);
  } finally { env.store.close(); temp.cleanup(); }
});

test('PRINT设备有效租约领取/下载/提交，撤权、错token、INFER能力和跨设备回执拒绝', () => {
  const env = setup();
  try {
    const order = sale(env), queued = queue(env, order), auth = env.register();
    const other = env.register(), infer = env.register(randomUUID(), ['INFER']);
    for (const invalid of [{ ...auth, token: 'wrong' }, infer]) error(() => env.service.claimPrint(invalid), 'DEVICE_FORBIDDEN', 403);
    const claim = env.service.claimPrint(auth); assert.equal(claim.attempt.id, queued.id);
    assert.equal(claim.attempt.status, 'SUBMIT_INTENT'); assert.equal(claim.attempt.leaseTokenHash, undefined);
    assert.equal(JSON.stringify(env.store.read()).includes(auth.token), false);
    assert.equal(JSON.stringify(env.store.read()).includes(claim.leaseToken), false);
    assert.equal(env.service.readableAttempt({ ...auth, attemptId: queued.id, leaseToken: claim.leaseToken }).document.id, queued.document.id);
    error(() => env.service.readableAttempt({ ...other, attemptId: queued.id, leaseToken: claim.leaseToken }), 'PRINT_LEASE_CONFLICT', 409);
    error(() => env.service.markSubmitted(receipt(claim, other), other), 'PRINT_LEASE_CONFLICT', 409);
    error(() => env.service.markSubmitted({ ...receipt(claim, auth), deviceId: other.deviceId }, auth), 'DEVICE_FORBIDDEN', 403);
    env.edge.revokeDevice({ operationId: 'off', deviceId: auth.deviceId }, boss);
    error(() => env.service.markSubmitted(receipt(claim, auth), auth), 'DEVICE_FORBIDDEN', 403);
    error(() => env.service.readableAttempt({ ...auth, attemptId: queued.id, leaseToken: claim.leaseToken }), 'DEVICE_FORBIDDEN', 403);
    assert.equal(env.service.list()[0].status, 'SUBMIT_INTENT');
  } finally { env.store.close(); }
});

test('设备回执幂等与冲突；只能老板人工验纸，补打一份复用冻结PDF且不增加销售', () => {
  const env = setup();
  try {
    const order = sale(env), attempt = queue(env, order), auth = env.register();
    const claim = env.service.claimPrint(auth), input = receipt(claim, auth, 'submit');
    const { queueId: ignoredQueueId, ...withoutQueueId } = input;
    error(() => env.service.markSubmitted(withoutQueueId, auth), 'INVALID_SUBMISSION');
    const before = env.store.read();
    const submitted = env.service.markSubmitted(input, auth);
    assert.equal(submitted.status, 'SPOOLER_ACCEPTED');
    assert.deepEqual(env.service.markSubmitted(input, auth), submitted);
    assert.deepEqual(env.service.markSubmitted({ ...input, operationId: 'other-submit-id' }, auth), submitted);
    error(() => env.service.markSubmitted({ ...input, outcome: 'UNCERTAIN' }, auth), 'IDEMPOTENCY_CONFLICT', 409);
    error(() => env.service.markSubmitted({ ...input, operationId: 'different-receipt', outcome: 'UNCERTAIN' }, auth), 'PRINT_RECEIPT_CONFLICT', 409);
    error(() => env.service.reprint({ operationId: 'before-paper', attemptId: attempt.id }, boss), 'INVALID_PRINT_STATE', 409);
    const paper = { operationId: 'not-printed', attemptId: attempt.id, printed: false };
    const checked = env.service.confirmPaper(paper, boss); assert.equal(checked.status, 'PAPER_NOT_PRINTED');
    assert.deepEqual(env.service.confirmPaper(paper, boss), checked);
    error(() => env.service.confirmPaper({ ...paper, printed: true }, boss), 'IDEMPOTENCY_CONFLICT', 409);
    const retry = { operationId: 'reprint', attemptId: attempt.id };
    const reprinted = env.service.reprint(retry, boss);
    assert.notEqual(reprinted.id, attempt.id); assert.equal(reprinted.copies, 1);
    assert.equal(reprinted.revision, attempt.revision); assert.deepEqual(reprinted.document, attempt.document);
    assert.equal(reprinted.snapshotSha256, attempt.snapshotSha256);
    assert.deepEqual(env.service.reprint(retry, boss), reprinted);
    assert.equal(env.service.reprint({ ...retry, operationId: 'same-parent-new-op' }, boss).id, reprinted.id);
    assert.equal(env.service.list().length, 2); assert.equal(env.countDocuments(), 1);
    for (const field of ['orders', 'salesEvents', 'prices', 'priceEvents']) assert.deepEqual(env.store.read()[field], before[field]);
    const secondClaim = env.service.claimPrint(auth);
    assert.equal(secondClaim.attempt.id, reprinted.id);
    env.service.markSubmitted(receipt(secondClaim, auth), auth);
    const printed = env.service.confirmPaper({ operationId: 'paper-yes', attemptId: reprinted.id, printed: true }, boss);
    assert.equal(printed.status, 'PAPER_CONFIRMED');
    error(() => env.service.reprint({ operationId: 'no-third', attemptId: reprinted.id }, boss), 'INVALID_PRINT_STATE', 409);
    error(() => queue(env, order), 'INVALID_PRINT_STATE', 409); assert.equal(env.service.list().length, 2);
  } finally { env.store.close(); }
});

test('明确提交前失败可补打；结果未知不能自动补打，失效租约迟到不能覆盖人工', () => {
  const env = setup();
  try {
    const order = sale(env), attempt = queue(env, order), auth = env.register();
    const claim = env.service.claimPrint(auth);
    const failed = env.service.markSubmitted(receipt(claim, auth, 'before-spool', 'FAILED_BEFORE_SPOOL'), auth);
    assert.equal(failed.status, 'FAILED_BEFORE_SPOOL');
    const second = env.service.reprint({ operationId: 'after-failure', attemptId: attempt.id }, boss);
    const secondClaim = env.service.claimPrint(auth); assert.equal(secondClaim.attempt.id, second.id);
    env.advance(120_000);
    assert.equal(env.service.expireClaims().uncertainCount, 1);
    assert.equal(env.service.expireClaims().uncertainCount, 0);
    assert.equal(env.service.list()[1].status, 'UNCERTAIN');
    assert.deepEqual(env.service.claimPrint(auth), { attempt: null });
    error(() => env.service.reprint({ operationId: 'unknown-retry', attemptId: second.id }, boss), 'INVALID_PRINT_STATE', 409);
    error(() => env.service.markSubmitted(receipt(secondClaim, auth), auth), 'PRINT_LEASE_CONFLICT', 409);
    env.service.confirmPaper({ operationId: 'manual-unknown-no', attemptId: second.id, printed: false }, boss);
    const after = env.store.read();
    error(() => env.service.markSubmitted(receipt(secondClaim, auth), auth), 'PRINT_LEASE_CONFLICT', 409);
    assert.deepEqual(env.store.read(), after);
  } finally { env.store.close(); }
});

function correctQuantity(env, order) {
  const q = env.business.quote({ customerId: order.customerId, skuId: order.items[0].skuId, unit: order.items[0].unit });
  return env.business.correctSale(order.id, { operationId: randomUUID(), expectedRevision: order.revision,
    customerId: order.customerId, items: [{ ...order.items[0], quantity: 3, priceVersion: q.version }] }, boss);
}
test('更正前未提交旧版可SUPERSEDED；已提交风险旧版阻止自动换版，旧PDF身份不覆盖', () => {
  const env = setup();
  try {
    const first = sale(env), old = queue(env, first);
    const corrected = correctQuantity(env, first), newer = queue(env, corrected);
    assert.equal(newer.revision, 2); assert.notEqual(newer.document.id, old.document.id);
    assert.equal(env.service.list()[0].status, 'SUPERSEDED');
    assert.equal(env.service.list()[0].document.id, old.document.id);
    const secondOrder = sale(env), potential = queue(env, secondOrder), auth = env.register();
    const claim1 = env.service.claimPrint(auth); // the corrected first order goes first
    env.service.markSubmitted(receipt(claim1, auth), auth);
    env.service.confirmPaper({ operationId: 'first-order-paper', attemptId: claim1.attempt.id, printed: true }, boss);
    const claim = env.service.claimPrint(auth); assert.equal(claim.attempt.id, potential.id);
    const secondCorrected = correctQuantity(env, secondOrder);
    const before = env.store.read();
    error(() => queue(env, secondCorrected), 'PRINT_REVIEW_REQUIRED', 409);
    assert.deepEqual(env.store.read(), before);
    env.service.markSubmitted(receipt(claim, auth), auth);
    env.service.confirmPaper({ operationId: 'old-version-no-paper', attemptId: potential.id, printed: false }, boss);
    error(() => env.service.reprint({ operationId: 'obsolete-reprint', attemptId: potential.id }, boss), 'ORDER_VERSION_CONFLICT', 409);
    const latest = queue(env, secondCorrected);
    assert.equal(latest.revision, 2);
    assert.equal(env.service.list().find(value => value.id === potential.id).document.id, potential.document.id);
  } finally { env.store.close(); }
});

test('SQLite重启后未知打印不重排，过期租约仅保守UNCERTAIN且不新增销售或任务', () => {
  const temp = temporary(), filename = join(temp.directory, 'state.sqlite');
  const env = setup({ filename }); let store = env.store;
  try {
    const order = sale(env), attempt = queue(env, order), auth = env.register();
    const claim = env.service.claimPrint(auth), events = env.store.read().salesEvents;
    store.close(); store = createStore({ filename }); env.advance(120_001);
    const recovered = createPrintService({ store, documentStore: env.documentStore, now: env.now });
    assert.equal(recovered.expireClaims().uncertainCount, 1);
    assert.deepEqual(recovered.claimPrint(auth), { attempt: null });
    assert.equal(recovered.list().length, 1); assert.equal(recovered.list()[0].id, attempt.id);
    assert.equal(recovered.list()[0].status, 'UNCERTAIN');
    error(() => recovered.markSubmitted(receipt(claim, auth), auth), 'PRINT_LEASE_CONFLICT', 409);
    assert.deepEqual(store.read().salesEvents, events);
    assert.equal(JSON.stringify(store.read()).includes(claim.leaseToken), false);
  } finally { store?.close(); temp.cleanup(); }
});

const printWorker = new URL(`data:text/javascript,${encodeURIComponent(`
  import { parentPort, workerData } from 'node:worker_threads';
  const { createStore } = await import(workerData.storeUrl);
  const { createPrintService } = await import(workerData.serviceUrl);
  const store = createStore({filename:workerData.filename});
  try {
    const service = createPrintService({store,now:()=>workerData.now});
    parentPort.postMessage({ready:true});
    Atomics.wait(new Int32Array(workerData.barrier),0,0,5000);
    parentPort.postMessage({id:service.claimPrint(workerData.auth).attempt?.id??null});
  } catch (error) { parentPort.postMessage({error:{message:error.message}}); }
  finally {store.close();}
`)}`);
test('两个真实SQLite连接竞争同打印任务仅一个SUBMIT_INTENT，失联任务无自动再领', async () => {
  const temp = temporary(), filename = join(temp.directory, 'state.sqlite'), env = setup({ filename });
  const workers = [];
  try {
    const order = sale(env); queue(env, order);
    const auths = [env.register(), env.register()], barrier = new SharedArrayBuffer(4);
    const ready = [], outcomes = [];
    for (const auth of auths) {
      const worker = new Worker(printWorker, { workerData: { filename, now: env.now(), auth, barrier,
        storeUrl: new URL('../../src/shared/store.mjs', import.meta.url).href,
        serviceUrl: new URL('../../src/printing/index.mjs', import.meta.url).href } }); workers.push(worker);
      let whenReady, resolveOutcome, rejectOutcome;
      ready.push(new Promise(resolve => { whenReady = resolve; }));
      outcomes.push(new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; }));
      worker.on('message', value => {
        if (value.ready) whenReady();
        else if (value.error) { whenReady(); rejectOutcome(new Error(value.error.message)); }
        else resolveOutcome(value.id);
      }); worker.on('error', value => { whenReady(); rejectOutcome(value); });
    }
    await Promise.all(ready); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2);
    const outcome = await Promise.all(outcomes); assert.equal(outcome.filter(Boolean).length, 1);
    assert.equal(env.service.list().length, 1); assert.equal(env.service.list()[0].status, 'SUBMIT_INTENT');
    env.advance(120_000); assert.deepEqual(env.service.claimPrint(auths[0]), { attempt: null });
    assert.equal(env.service.list()[0].status, 'UNCERTAIN');
  } finally { await Promise.all(workers.map(value => value.terminate())); env.store.close(); temp.cleanup(); }
});
