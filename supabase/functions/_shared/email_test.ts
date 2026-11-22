import { assertEquals } from 'jsr:@std/assert@1.0.13';
import { domainDeliverable } from './email.ts';

const notFound = () => Object.assign(new Error('no records'), { name: 'NotFound' });

Deno.test('有 MX 记录：能收信', async () => {
  assertEquals(await domainDeliverable('gmail.com', async () => [{ preference: 5, exchange: 'gmail-smtp-in.l.google.com.' }]), true);
});

Deno.test('没有 MX 记录（如 panda.com）：收不到信', async () => {
  assertEquals(await domainDeliverable('panda.com', async () => { throw notFound(); }), false);
  assertEquals(await domainDeliverable('panda.com', async () => []), false);
});

Deno.test('格式不对的域名：收不到信', async () => {
  assertEquals(await domainDeliverable('localhost', async () => [1]), false);
  assertEquals(await domainDeliverable('', async () => [1]), false);
});

Deno.test('查询出错（网络等）：返回 null，由调用方放行', async () => {
  assertEquals(await domainDeliverable('example.org', async () => { throw new Error('timeout'); }), null);
});

Deno.test('大小写与末尾的点不影响', async () => {
  let seen = '';
  await domainDeliverable('Gmail.COM.', async (d) => { seen = d; return [1]; });
  assertEquals(seen, 'gmail.com');
});

Deno.test('保留给测试的域名（test.local 等）：本地放行，云端拦下', async () => {
  for (const d of ['test.local', 'review.local', 'foo.test', 'x.example', 'a.invalid']) {
    assertEquals(await domainDeliverable(d, async () => [1], { local: true }), null);
    assertEquals(await domainDeliverable(d, async () => [1]), false);
  }
});
