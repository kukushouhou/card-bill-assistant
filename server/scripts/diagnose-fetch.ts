// 诊断脚本：分批 fetch envelope 耗时测试（定位大批量卡点），用完即删
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/config';
import { decrypt } from '../src/lib/crypto';

async function main() {
  const account = await prisma.emailAccount.findFirst();
  if (!account) throw new Error('无邮箱账户');
  const password = decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc));
  const client = new ImapFlow({ host: account.imapHost, port: account.imapPort, secure: account.tls, auth: { user: account.authUser, pass: password }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    console.log('search all...');
    const t0 = Date.now();
    const allUids = ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b);
    console.log(`search 完成 ${allUids.length} 封，耗时 ${Date.now() - t0}ms，前3个uid=${allUids.slice(0, 3).join(',')}`);

    // 逐批测试：第 1 批（最早）、中间批、最后一批，每批 100 封
    for (const [label, uids] of [
      ['最早100', allUids.slice(0, 100)] as const,
      ['中段100', allUids.slice(8700, 8800)] as const,
      ['最新100', allUids.slice(-100)] as const,
    ]) {
      const t = Date.now();
      try {
        const msgs = await client.fetchAll(uids as unknown as number[], { uid: true, envelope: true }, { uid: true });
        console.log(`${label}: ${msgs.length} 封，耗时 ${Date.now() - t}ms`);
      } catch (err) {
        console.log(`${label}: 失败 ${Date.now() - t0}ms - ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
