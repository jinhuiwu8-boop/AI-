import { createEmptyState } from './store.mjs';

export function createDemoState() {
  const state = createEmptyState();
  state.customers = [
    { id: 'C-A', name: '示例·好运便利店', address: '合成样例地址一', aliases: ['好运店'] },
    { id: 'C-B', name: '示例·顺心烟酒店', address: '合成样例地址二', aliases: ['顺心店'] },
  ];
  state.products = [
    { id: 'SKU-S', name: '示例啤酒 500ml×24', units: ['箱', '瓶'], bottlesPerCase: 24 },
    { id: 'SKU-T', name: '示例饮料 350ml×12', units: ['箱', '瓶'], bottlesPerCase: 12 },
  ];
  state.sources = [{ id: 'local-source-1', active: true, name: '本地合成转单来源' }];
  return state;
}
