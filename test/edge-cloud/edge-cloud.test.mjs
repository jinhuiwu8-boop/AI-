import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createStore } from '../../src/shared/store.mjs';
import { createDemoState } from '../../src/shared/seed.mjs';
import { createIntakeService } from '../../src/intake/index.mjs';
import { createEdgeService } from '../../src/edge-cloud/index.mjs';

const boss = { id: 'boss-synthetic', role: 'boss', active: true };
const startsAt = '2026-10-31T00:00:00.000Z';
// A data URL keeps this helper out of Node's default test-file discovery while
// still opening real independent SQLite connections in two worker isolates.
const claimWorker = new URL(`data:text/javascript,${encodeURIComponent(`
  import { parentPort, workerData } from 'node:worker_threads';
  const { createStore } = await import(workerData.storeUrl);
  const { createEdgeService } = await import(workerData.serviceUrl);
  const store = createStore({ filename: workerData.filename });
  try {
    const service = createEdgeService({ store, now: () => workerData.now });
    const barrier = new Int32Array(workerData.barrier);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0, 5000);
    const result = service.claimInference(workerData.credentials);
    parentPort.postMessage({ jobId: result.job?.id ?? null });
  } catch (error) {
    parentPort.postMessage({ error: { code: error.code, message: error.message } });
  } finally { store.close(); }
`)}`);
const result = () => ({ customerId: 'C-A', items: [{ skuId: 'SKU-S', productName: '示例啤酒', unit: '箱', quantity: 2 }], issues: [] });
const credentials = registration => ({ deviceId: registration.device.id, token: registration.token });
const expectError = (fn, code, status) => assert.throws(fn, error => error.code === code && (status === undefined || error.status === status));
function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-edge-test-'));
  return { directory, cleanup() {
    // The target must remain a strict child of the OS temp directory before a
    // recursive cleanup. No calculated path is passed to another shell.
    const part = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(part && !part.startsWith('..') && !isAbsolute(part));
    rmSync(directory, { recursive: true, force: true });
  } };
}
function setup(filename = ':memory:', leaseSeconds = 120) {
  const store = createStore({ filename, initialState: createDemoState() });
  let clock = Date.parse(startsAt);
  const now = () => new Date(clock).toISOString();
  return {
    store, service: createEdgeService({ store, now, leaseSeconds }),
    intake: createIntakeService({ store, now }),
    advance: milliseconds => { clock += milliseconds; }, now,
    register: (operationId = 'register', capability = ['INFER']) => createEdgeService({ store, now, leaseSeconds })
      .registerDevice({ operationId, name: `合成设备-${operationId}`, capabilities: capability }, boss),
  };
}
function batch(env, suffix = 'one', sourceId = 'local-source-1', conversationId = 'conversation-1') {
  env.intake.receive({ sourceId, conversationId, messageId: `customer-${suffix}`, type: 'TEXT', kind: 'customer', text: '好运店', customerHint: '好运店', media: [] });
  env.intake.receive({ sourceId, conversationId, messageId: `product-${suffix}`, type: 'IMAGE', kind: 'product', text: '', customerHint: '', media: [{ id: `image-${suffix}`, relativePath: `media/${suffix}.png`, sizeBytes: 42, sha256: 'a'.repeat(64), mimeType: 'image/png' }] });
  env.advance(60_000); env.intake.sealDue();
  return env.store.read().edgeJobs.at(-1);
}
const leaseInput = (registration, lease, value = result()) => ({ ...credentials(registration), jobId: lease.job.id, leaseToken: lease.leaseToken, result: value });

test('仅老板登记和撤权；原token仅首次返回、只存摘要，幂等不额外登记或泄露token', () => {
  const env = setup();
  try {
    const command = { operationId: 'op', name: '测试设备', capabilities: ['PRINT', 'INFER', 'INFER'] };
    for (const actor of [undefined, { role: 'boss', active: false }, { role: 'staff', active: true }]) {
      expectError(() => env.service.registerDevice(command, actor), 'FORBIDDEN', 403);
    }
    const first = env.service.registerDevice(command, boss);
    assert.equal(first.tokenAvailable, true); assert.equal(first.duplicate, false);
    assert.match(first.token, /^[a-zA-Z0-9_-]{43}$/);
    assert.deepEqual(first.device.capabilities, ['INFER', 'PRINT']);
    assert.equal(first.device.tokenHash, undefined);
    const state = env.store.read();
    assert.equal(state.edgeDevices[0].tokenHash, createHash('sha256').update(first.token).digest('hex'));
    assert.equal(JSON.stringify(state).includes(first.token), false);
    assert.equal(JSON.stringify(env.service.listDevices()).includes('token'), false);
    const retry = env.service.registerDevice({ ...command, capabilities: ['INFER', 'PRINT'] }, boss);
    assert.equal(retry.device.id, first.device.id); assert.equal(retry.token, null);
    assert.equal(retry.tokenAvailable, false); assert.equal(retry.duplicate, true);
    assert.match(retry.message, /无法再次读取/);
    assert.equal(env.service.listDevices().length, 1);
    expectError(() => env.service.registerDevice({ ...command, name: '另一台' }, boss), 'IDEMPOTENCY_CONFLICT', 409);
    expectError(() => env.service.registerDevice(command, { ...boss, id: 'other' }), 'IDEMPOTENCY_CONFLICT', 409);
    const list = env.service.listDevices(); list[0].capabilities.push('BAD');
    assert.deepEqual(env.service.listDevices()[0].capabilities, ['INFER', 'PRINT']);
    expectError(() => env.service.revokeDevice({ operationId: 'off', deviceId: first.device.id }, { role: 'staff', active: true }), 'FORBIDDEN', 403);
    const revoked = env.service.revokeDevice({ operationId: 'off', deviceId: first.device.id }, boss);
    assert.equal(revoked.device.active, false);
    assert.deepEqual(env.service.revokeDevice({ operationId: 'off', deviceId: first.device.id }, boss), revoked);
    assert.equal(env.service.registerDevice(command, boss).device.active, false);
  } finally { env.store.close(); }
});

test('错token、未知设备及能力不符不能认证或领取；各阶段撤权立即阻止设备', () => {
  const env = setup();
  try {
    batch(env);
    const infer = env.register(), print = env.register('print', ['PRINT']);
    for (const auth of [{ deviceId: infer.device.id, token: 'bad' }, { deviceId: 'missing', token: infer.token }, credentials(print)]) {
      expectError(() => env.service.claimInference(auth), 'DEVICE_FORBIDDEN', 403);
    }
    expectError(() => env.service.authenticate(credentials(infer), 'BAD'), 'INVALID_CAPABILITY');
    assert.equal(env.service.authenticate(credentials(print), 'PRINT').deviceId, print.device.id);
    const claim = env.service.claimInference(credentials(infer));
    const input = leaseInput(infer, claim);
    env.service.revokeDevice({ operationId: 'revoke', deviceId: infer.device.id }, boss);
    for (const fn of [() => env.service.authenticate(credentials(infer), 'INFER'), () => env.service.claimInference(credentials(infer)), () => env.service.renewInference(input), () => env.service.completeInference(input)]) {
      expectError(fn, 'DEVICE_FORBIDDEN', 403);
    }
    assert.equal(env.store.read().edgeJobs[0].candidate, undefined);
  } finally { env.store.close(); }
});

test('领取返回自身封单原文及受控媒体，不串相同消息号的其他来源、会话和批次', () => {
  const env = setup();
  try {
    batch(env);
    env.store.transact(state => {
      const copied = structuredClone(state.messages[1]);
      state.messages.unshift({ ...copied, sourceId: 'other-source', text: '不能泄露的来源文字', media: [{ id: 'other-source-media' }] });
      state.messages.unshift({ ...copied, conversationId: 'other-conversation', text: '不能泄露的会话文字', media: [{ id: 'other-conversation-media' }] });
      state.messages.unshift({ ...copied, result: { ...copied.result, batchId: 'other-batch' }, text: '不能泄露的批次文字', media: [{ id: 'other-batch-media' }] });
      state.edgeJobs[0].internalSecret = '不能泄露的内部字段';
      return null;
    });
    const device = env.register();
    const claim = env.service.claimInference(credentials(device));
    assert.equal(claim.job.status, 'INFER_RUNNING'); assert.equal(claim.job.messages.length, 2);
    assert.deepEqual(claim.job.messages.map(message => message.messageId), ['customer-one', 'product-one']);
    assert.equal(claim.job.messages[1].media[0].id, 'image-one');
    const publicText = JSON.stringify(claim.job);
    assert.equal(publicText.includes('不能泄露'), false); assert.equal(publicText.includes('canonical'), false);
    assert.equal(publicText.includes('Hash'), false); assert.equal(publicText.includes(device.token), false);
    assert.equal(env.store.read().edgeJobs[0].leaseTokenHash.length, 64);
    assert.equal(JSON.stringify(env.store.read()).includes(claim.leaseToken), false);
    assert.deepEqual(env.service.claimInference(credentials(device)), { job: null });
  } finally { env.store.close(); }
});

test('非法批次归属领取失败整笔回滚，不能借messageIds读取其他批次附件', () => {
  const env = setup();
  try {
    batch(env);
    const device = env.register();
    env.store.transact(state => { state.edgeJobs[0].messageIds.push('not-from-this-batch'); return null; });
    const before = env.store.read();
    expectError(() => env.service.claimInference(credentials(device)), 'JOB_DATA_INVALID', 409);
    assert.deepEqual(env.store.read(), before);
  } finally { env.store.close(); }
});

test('默认120秒租约、有效续租与边界过期再领取；旧设备租约不能回传或续租', () => {
  const env = setup();
  try {
    batch(env);
    const first = env.register('first'), second = env.register('second');
    const lease = env.service.claimInference(credentials(first));
    assert.equal(Date.parse(lease.leaseUntil) - Date.parse(env.now()), 120_000);
    env.advance(60_000);
    const renewed = env.service.renewInference(leaseInput(first, lease));
    assert.equal(Date.parse(renewed.leaseUntil) - Date.parse(env.now()), 120_000);
    env.advance(119_999);
    assert.deepEqual(env.service.claimInference(credentials(second)), { job: null });
    env.advance(1);
    expectError(() => env.service.completeInference(leaseInput(first, lease)), 'LEASE_CONFLICT', 409);
    expectError(() => env.service.renewInference(leaseInput(first, lease)), 'LEASE_CONFLICT', 409);
    const replacement = env.service.claimInference(credentials(second));
    assert.equal(replacement.job.id, lease.job.id); assert.equal(replacement.job.attempt, 2);
    assert.notEqual(replacement.leaseToken, lease.leaseToken);
    expectError(() => env.service.completeInference(leaseInput(first, lease)), 'LEASE_CONFLICT', 409);
    const completed = env.service.completeInference(leaseInput(second, replacement));
    assert.equal(completed.status, 'AWAITING_REVIEW');
    expectError(() => env.service.completeInference(leaseInput(first, lease)), 'LEASE_CONFLICT', 409);
  } finally { env.store.close(); }
});

test('租约秒数可配置；错误设备/错误lease token不能越权续租或回传', () => {
  const env = setup(':memory:', 15);
  try {
    batch(env);
    const first = env.register('first'), second = env.register('second');
    const lease = env.service.claimInference(credentials(first));
    assert.equal(Date.parse(lease.leaseUntil) - Date.parse(env.now()), 15_000);
    for (const input of [{ ...leaseInput(first, lease), leaseToken: 'wrong' }, { ...leaseInput(first, lease), ...credentials(second) }]) {
      const before = env.store.read();
      expectError(() => env.service.renewInference(input), 'LEASE_CONFLICT', 409);
      expectError(() => env.service.completeInference(input), 'LEASE_CONFLICT', 409);
      assert.deepEqual(env.store.read(), before);
    }
  } finally { env.store.close(); }
});

test('识别完成只存候选；同规范结果重放不追加，异结果409，人工核对后迟到回传不覆盖', () => {
  const env = setup();
  try {
    batch(env);
    const device = env.register(); const lease = env.service.claimInference(credentials(device));
    const before = env.store.read();
    const completed = env.service.completeInference(leaseInput(device, lease));
    assert.match(completed.candidateVersion, /^inference:/); assert.match(completed.resultSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(completed.candidate, result());
    const accepted = env.store.read();
    for (const field of ['customers', 'products', 'prices', 'priceEvents', 'orders', 'salesEvents', 'printAttempts', 'correctionSamples']) {
      assert.deepEqual(accepted[field], before[field], `${field}不能因模型回传改变`);
    }
    env.advance(1_000_000);
    const shuffled = { items: [{ quantity: 2, productName: ' 示例啤酒 ', skuId: ' SKU-S ', unit: '箱' }], issues: [], customerId: ' C-A ' };
    assert.deepEqual(env.service.completeInference(leaseInput(device, lease, shuffled)), completed);
    assert.deepEqual(env.store.read(), accepted);
    expectError(() => env.service.completeInference(leaseInput(device, lease, { ...result(), customerId: 'C-B' })), 'RESULT_CONFLICT', 409);
    env.store.transact(state => { state.edgeJobs[0].status = 'REVIEWED'; state.edgeJobs[0].reviewOrderId = 'synthetic-reviewed'; return null; });
    const reviewed = env.store.read();
    assert.deepEqual(env.service.completeInference(leaseInput(device, lease)), completed);
    assert.deepEqual(env.store.read(), reviewed);
    expectError(() => env.service.completeInference(leaseInput(device, lease, { ...result(), customerId: null })), 'RESULT_CONFLICT', 409);
    expectError(() => env.service.renewInference(leaseInput(device, lease)), 'LEASE_CONFLICT', 409);
    assert.deepEqual(env.store.read(), reviewed);
    env.service.revokeDevice({ operationId: 'off', deviceId: device.device.id }, boss);
    expectError(() => env.service.completeInference(leaseInput(device, lease)), 'DEVICE_FORBIDDEN', 403);
  } finally { env.store.close(); }
});

test('候选支持null待人工补项；未知主档、非法单位/数量、长文本和价格字段均拒绝', () => {
  const env = setup();
  try {
    batch(env);
    const device = env.register(), lease = env.service.claimInference(credentials(device));
    const invalid = [
      [{ ...result(), customerId: 'unknown' }, 'UNKNOWN_CUSTOMER'],
      [{ ...result(), items: [{ ...result().items[0], skuId: 'unknown' }] }, 'UNKNOWN_PRODUCT'],
      [{ ...result(), items: [{ ...result().items[0], unit: '件' }] }, 'INVALID_UNIT'],
      [{ ...result(), items: [{ ...result().items[0], quantity: 1.5 }] }, 'INVALID_QUANTITY'],
      [{ ...result(), items: [{ ...result().items[0], quantity: 0 }] }, 'INVALID_QUANTITY'],
      [{ ...result(), items: [{ ...result().items[0], quantity: Number.MAX_SAFE_INTEGER + 1 }] }, 'INVALID_QUANTITY'],
      [{ ...result(), items: Array.from({ length: 101 }, () => result().items[0]) }, 'INVALID_ITEMS'],
      [{ ...result(), items: [{ ...result().items[0], productName: 'a'.repeat(301) }] }, 'INVALID_INPUT'],
      [{ ...result(), issues: ['a'.repeat(501)] }, 'INVALID_INPUT'],
      [{ ...result(), issues: Array(101).fill('错误') }, 'INVALID_ISSUES'],
      [{ ...result(), priceCents: 1 }, 'UNCONTROLLED_RESULT'],
      [{ ...result(), items: [{ ...result().items[0], priceCents: 1 }] }, 'UNCONTROLLED_RESULT'],
      [{ ...result(), checked: true }, 'UNCONTROLLED_RESULT'],
      [{ ...result(), customer: { name: '自动建档' } }, 'UNCONTROLLED_RESULT'],
    ];
    const before = env.store.read();
    for (const [value, code] of invalid) {
      expectError(() => env.service.completeInference(leaseInput(device, lease, value)), code);
      assert.deepEqual(env.store.read(), before);
    }
    const nulls = { customerId: null, items: [{ skuId: null, productName: '待核商品', unit: null, quantity: null }], issues: ['客户及明细需人工补充'] };
    assert.deepEqual(env.service.completeInference(leaseInput(device, lease, nulls)).candidate, nulls);
    assert.equal(env.store.read().customers.length, 2); assert.equal(env.store.read().products.length, 2);
    assert.equal(env.store.read().orders.length, 0); assert.equal(env.store.read().salesEvents.length, 0);
  } finally { env.store.close(); }
});

test('已完成结果重放使用冻结规范摘要，之后商品单位和客户主档变化不否定原成功回执', () => {
  const env = setup();
  try {
    batch(env); const device = env.register();
    const lease = env.service.claimInference(credentials(device));
    const input = leaseInput(device, lease), completed = env.service.completeInference(input);
    env.store.transact(state => {
      state.products.find(product => product.id === 'SKU-S').units = ['瓶'];
      state.customers = state.customers.filter(customer => customer.id !== 'C-A');
      return null;
    });
    const before = env.store.read();
    assert.deepEqual(env.service.completeInference(input), completed);
    assert.deepEqual(env.store.read(), before);
    expectError(() => env.service.completeInference({ ...input, result: { ...result(), customerId: 'removed-customer' } }), 'RESULT_CONFLICT', 409);
    assert.deepEqual(env.store.read(), before);
  } finally { env.store.close(); }
});

test('SQLite重启保留设备摘要、租约及完成回执；数据库文件不含完整设备或租约token', () => {
  const temporary = tempDirectory(); const filename = join(temporary.directory, 'edge.sqlite');
  const env = setup(filename); let store = env.store;
  try {
    batch(env);
    const device = env.register(), lease = env.service.claimInference(credentials(device));
    store.close(); store = createStore({ filename });
    const resumed = createEdgeService({ store, now: env.now });
    assert.equal(resumed.authenticate(credentials(device), 'INFER').deviceId, device.device.id);
    assert.deepEqual(resumed.claimInference(credentials(device)), { job: null });
    const completed = resumed.completeInference(leaseInput(device, lease));
    store.close(); store = createStore({ filename });
    const recovered = createEdgeService({ store, now: env.now });
    assert.deepEqual(recovered.completeInference(leaseInput(device, lease)), completed);
    assert.equal(store.read().edgeJobs[0].status, 'AWAITING_REVIEW');
    store.close(); store = null;
    const bytes = readFileSync(filename);
    assert.equal(bytes.includes(Buffer.from(device.token)), false);
    assert.equal(bytes.includes(Buffer.from(lease.leaseToken)), false);
  } finally { store?.close(); temporary.cleanup(); }
});

test('两个真实SQLite连接由Worker同时抢同任务，只有一个获得租约且无销售差量', async () => {
  const temporary = tempDirectory(); const filename = join(temporary.directory, 'edge.sqlite');
  const env = setup(filename); const workers = [];
  try {
    batch(env);
    const devices = [env.register('one'), env.register('two')];
    const barrier = new SharedArrayBuffer(4); const signal = new Int32Array(barrier);
    const ready = [], outcomes = [];
    for (const device of devices) {
      const worker = new Worker(claimWorker, { workerData: {
        filename, now: env.now(), credentials: credentials(device), barrier,
        storeUrl: new URL('../../src/shared/store.mjs', import.meta.url).href,
        serviceUrl: new URL('../../src/edge-cloud/index.mjs', import.meta.url).href,
      } });
      workers.push(worker);
      let readyResolve, outcomeResolve, outcomeReject;
      ready.push(new Promise(resolve => { readyResolve = resolve; }));
      outcomes.push(new Promise((resolve, reject) => { outcomeResolve = resolve; outcomeReject = reject; }));
      worker.on('message', value => {
        if (value.ready) readyResolve();
        else if (value.error) { readyResolve(); outcomeReject(new Error(value.error.message)); }
        else outcomeResolve(value.jobId);
      });
      worker.on('error', error => { readyResolve(); outcomeReject(error); });
    }
    await Promise.all(ready);
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0, 2);
    const claimed = await Promise.all(outcomes);
    assert.equal(claimed.filter(Boolean).length, 1);
    assert.equal(env.store.read().edgeJobs[0].attempt, 1);
    assert.equal(env.store.read().orders.length, 0); assert.equal(env.store.read().salesEvents.length, 0);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); env.store.close(); temporary.cleanup(); }
});

test('配置、输入和时间错误返回DomainError且不部分写入', () => {
  const env = setup();
  try {
    for (const leaseSeconds of [0, -1, 1.5, Infinity, '120']) expectError(() => createEdgeService({ store: env.store, leaseSeconds }), 'INVALID_LEASE_CONFIG');
    expectError(() => env.service.registerDevice({ operationId: 'bad', name: '设备', capabilities: [] }, boss), 'INVALID_CAPABILITY');
    expectError(() => env.service.registerDevice({ operationId: 'bad', name: '设备', capabilities: ['BAD'] }, boss), 'INVALID_CAPABILITY');
    expectError(() => env.service.registerDevice({ operationId: '', name: '设备', capabilities: ['INFER'] }, boss), 'INVALID_INPUT');
    const badClock = createEdgeService({ store: env.store, now: () => 'not-a-time' });
    const before = env.store.read();
    expectError(() => badClock.registerDevice({ operationId: 'clock', name: '设备', capabilities: ['INFER'] }, boss), 'INVALID_CLOCK');
    assert.deepEqual(env.store.read(), before);
    expectError(() => env.service.revokeDevice({ operationId: 'unknown', deviceId: 'missing' }, boss), 'DEVICE_NOT_FOUND', 404);
  } finally { env.store.close(); }
});
