// Synthetic acceptance evidence only. This quantity bypass is not a production policy.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../src/shared/store.mjs';
import { createBusinessService } from '../../src/business/service.mjs';
import { createDocumentStore } from '../../src/documents/store.mjs';

const evidence = fileURLToPath(new URL('./evidence/', import.meta.url));
mkdirSync(evidence, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'a07-return-png-'));
const store = createStore();
try {
  store.transact(state => {
    state.customers = [{ id: 'A07-C', name: 'A07合成测试客户' }];
    state.products = [{ id: 'A07-S', name: '合成商品（每箱24瓶）', units: ['箱', '瓶'], bottlesPerCase: 24, version: '1' }];
    state.prices[JSON.stringify(['A07-C', 'A07-S', '箱'])] = { priceCents: 10000, version: 'a07-seed', source: 'SEED' };
  });
  const documents = createDocumentStore({ directory: temporary });
  const service = createBusinessService({ store, documentStore: documents, now: () => '2026-11-03T00:00:00Z',
    validateCustomerReturnQuantity() {} /* TEST ONLY; formal HTTP gate remains closed. */ });
  const actor = { id: 'a07-synthetic', role: 'boss', active: true };
  service.createSale({ operationId: randomUUID(), customerId: 'A07-C', mode: 'ELECTRONIC', checked: true,
    items: [{ skuId: 'A07-S', unit: '箱', quantity: 1, priceCents: 10000, priceVersion: 'a07-seed' }] }, actor);
  const q = service.returnQuote({ customerId: 'A07-C', skuId: 'A07-S', unit: '瓶' });
  const order = service.createReturn({ operationId: randomUUID(), returnBasis: 'CUSTOMER_HISTORY', checked: true, customerId: 'A07-C',
    items: [{ skuId: 'A07-S', unit: '瓶', quantity: 24, priceCents: q.priceCents, returnPriceVersion: q.version }] }, actor);
  assert.equal(order.items[0].priceCents, 420);
  assert.equal(order.totals.goodsCents, 10080);
  assert.equal(order.totals.receivableCents, 10080);
  assert.equal(order.sourceOrderId, undefined);
  const png = documents.read(order.document.id);
  assert.equal(createHash('sha256').update(png).digest('hex'), order.document.sha256);
  writeFileSync(join(evidence, '24瓶退货_100.80.png'), png);
  writeFileSync(join(evidence, '24瓶退货_冻结合成单据.json'), JSON.stringify({ scope: 'SYNTHETIC_TEST_ONLY_QUANTITY_BYPASS', order }, null, 2));
  console.log(JSON.stringify({ priceCents: 420, quantity: 24, goodsCents: 10080, receivableCents: 10080, pngSha256: order.document.sha256 }));
} finally {
  store.close();
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('a07-return-png-'));
  rmSync(temporary, { recursive: true, force: true });
}
