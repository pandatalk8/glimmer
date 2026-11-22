// 邮箱域名能不能收信：查 MX 记录。lookup 由调用方注入（线上用 Deno.resolveDns，测试用假数据）
export type MxLookup = (domain: string) => Promise<unknown[]>;

/** true：有邮件服务器；false：域名不存在或没有 MX；null：查不出来（网络等原因），调用方应放行 */
export async function domainDeliverable(domain: string, lookup: MxLookup): Promise<boolean | null> {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return false;
  // 保留给测试的域名（RFC 2606 / 6761）：本地后端的邮件进 Mailpit，可以用 tester@test.local；
  // 云端由 Supabase 自己拒绝并给出明确提示。这里不下结论，放行
  if (/\.(local|test|example|invalid|localhost)$/.test(d)) return null;
  try {
    const mx = await lookup(d);
    return mx.length > 0;
  } catch (e) {
    // 域名不存在或没有 MX 记录：Deno 抛 NotFound
    if ((e as Error)?.name === 'NotFound') return false;
    return null;
  }
}
