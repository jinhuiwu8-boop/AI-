import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/shared/store.mjs';
import { createIntakeService } from '../../src/intake/index.mjs';

function setup(filename = ':memory:') {
  const store = createStore({ filename });
  store.transact(state => { state.sources = [{ id: 'a', active: true }, { id: 'b', active: true }, { id: 'off', active: false }]; return null; });
  let clock = Date.parse('2026-10-31T00:00:00Z');
  return { store, service: createIntakeService({ store, now: () => new Date(clock).toISOString() }), advance: n => { clock += n; } };
}
const msg = (id, kind = 'product', overrides = {}) => ({ sourceId: 'a', conversationId: 'c', messageId: id, type: 'TEXT', kind, text: kind === 'customer' ? '客户甲' : '饮料两箱', customerHint: kind === 'customer' ? '客户甲' : '', media: [], ...overrides });

test('首产品启动60秒、新产品续时、重复不续时，边界封批只创建一次任务', () => {
  const { store, service, advance } = setup();
  try {
    service.receive(msg('c', 'customer'));
    assert.equal(service.listBatches()[0].deadline, null);
    advance(120_000);
    assert.equal(service.sealDue().sealedCount, 0);
    service.receive(msg('p1'));
    advance(30_000);
    service.receive(msg('p2'));
    const deadline = service.listBatches()[0].deadline;
    advance(29_999);
    assert.equal(service.receive(msg('p2')).duplicate, true);
    assert.equal(service.listBatches()[0].deadline, deadline);
    advance(30_000);
    assert.equal(service.sealDue().sealedCount, 0);
    advance(1);
    assert.equal(service.sealDue().sealedCount, 1);
    assert.equal(service.sealDue().sealedCount, 0);
    assert.equal(service.listJobs().length, 1);
    assert.equal(service.listJobs()[0].status, 'WAITING_EDGE');
    assert.equal(service.listJobs()[0].messageIds.length, 3);
    assert.equal(store.read().orders.length, 0);
    assert.equal(store.read().salesEvents.length, 0);
  } finally { store.close(); }
});

test('新客户切批、纯客户无空任务、无归属与截止时迟到不猜归属', () => {
  const { store, service, advance } = setup();
  try {
    assert.equal(service.receive(msg('orphan')).status, 'UNASSIGNED');
    service.receive(msg('c1', 'customer'));
    service.receive(msg('c2', 'customer', { customerHint: '客户乙' }));
    assert.equal(service.listJobs().length, 0);
    service.receive(msg('p'));
    service.receive(msg('c3', 'customer'));
    assert.equal(service.listJobs().length, 1);
    assert.equal(service.listJobs()[0].customerHint, '客户乙');
    service.receive(msg('u', 'unassigned'));
    assert.equal(service.listBatches().at(-1).productCount, 0);
    service.receive(msg('p3'));
    advance(60_000);
    assert.equal(service.receive(msg('late')).status, 'UNASSIGNED');
    assert.equal(service.listJobs().length, 2);
  } finally { store.close(); }
});

test('来源会话隔离、同ID内容冲突回滚及停用拒绝', () => {
  const { store, service } = setup();
  try {
    service.receive(msg('customer', 'customer'));
    service.receive(msg('same'));
    const before = store.read();
    assert.throws(() => service.receive(msg('same', 'product', { text: '不同' })), e => e.code === 'MESSAGE_CONFLICT' && e.status === 409);
    assert.deepEqual(store.read(), before);
    assert.equal(service.receive(msg('same', 'product', { sourceId: 'b' })).status, 'UNASSIGNED');
    assert.equal(service.receive(msg('same', 'product', { conversationId: 'other' })).status, 'UNASSIGNED');
    assert.throws(() => service.receive(msg('off', 'product', { sourceId: 'off' })), e => e.code === 'SOURCE_FORBIDDEN' && e.status === 403);
    assert.throws(() => service.receive(msg('missing', 'product', { sourceId: 'missing' })), e => e.code === 'SOURCE_FORBIDDEN');
    const copy = service.listBatches(); copy[0].customerHint = '篡改';
    assert.equal(service.listBatches()[0].customerHint, '客户甲');
  } finally { store.close(); }
});

test('文字图语音统一归批，媒体引用和路径校验不虚构下载', () => {
  const { store, service, advance } = setup();
  try {
    service.receive(msg('customer', 'customer'));
    service.receive(msg('t'));
    for (const type of ['IMAGE', 'VOICE']) service.receive(msg(type, 'product', { type, text: '', media: [{ id: `object-${type}`, relativePath: `media/${type}`, sizeBytes: 4 }] }));
    assert.equal(service.listBatches()[0].productCount, 3);
    assert.throws(() => service.receive(msg('bad', 'product', { type: 'VOICE', media: [] })), e => e.code === 'MEDIA_REQUIRED');
    for (const relativePath of ['/etc/passwd', '../private', 'a/../b', 'C:/private', 'a\\b']) assert.throws(() => service.receive(msg('path', 'product', { type: 'IMAGE', media: [{ id: 'x', relativePath }] })), e => e.code === 'INVALID_MEDIA');
    assert.throws(() => service.receive(msg('url', 'product', { type: 'IMAGE', media: [{ id: 'x', url: 'https://invalid/' }] })), e => e.code === 'INVALID_MEDIA');
    advance(60_000); service.sealDue();
    assert.equal(service.listJobs().length, 1);
    assert.equal(store.read().messages.length, 4);
  } finally { store.close(); }
});

test('真实SQLite关闭重开后按持久截止时间封批，重复回调不多建任务', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intake-test-'));
  const filename = join(directory, 'state.sqlite');
  let store;
  try {
    const first = setup(filename); store = first.store;
    first.service.receive(msg('customer', 'customer')); first.service.receive(msg('product'));
    store.close(); store = createStore({ filename });
    const recovered = createIntakeService({ store, now: () => '2026-10-31T00:01:00.000Z' });
    assert.equal(recovered.sealDue().sealedCount, 1);
    assert.equal(recovered.receive(msg('product')).duplicate, true);
    const id = recovered.listJobs()[0].id;
    store.close(); store = createStore({ filename });
    const again = createIntakeService({ store, now: () => '2026-10-31T00:02:00.000Z' });
    assert.equal(again.sealDue().sealedCount, 0);
    assert.equal(again.listJobs()[0].id, id);
    assert.equal(again.listJobs().length, 1);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('两个SQLite连接交错领取封批与重复消息保持单任务', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intake-two-'));
  const filename = join(directory, 'state.sqlite');
  const first = setup(filename);
  const secondStore = createStore({ filename });
  const second = createIntakeService({ store: secondStore, now: () => '2026-10-31T00:01:00.000Z' });
  try {
    first.service.receive(msg('customer', 'customer'));
    first.service.receive(msg('product'));
    assert.equal(second.receive(msg('product')).duplicate, true);
    assert.equal(second.sealDue().sealedCount, 1);
    first.advance(60_000);
    assert.equal(first.service.sealDue().sealedCount, 0);
    assert.equal(first.service.listJobs().length, 1);
    assert.equal(second.listJobs()[0].id, first.service.listJobs()[0].id);
  } finally { first.store.close(); secondStore.close(); rmSync(directory, { recursive: true, force: true }); }
});
