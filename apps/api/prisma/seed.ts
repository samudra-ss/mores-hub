/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding MORES-HUB demo data…');

  const pinHash = await argon2.hash('123456', { type: argon2.argon2id });

  const alice = await prisma.user.upsert({
    where: { email: 'alice@demo.mores-hub.id' },
    update: {},
    create: {
      googleSub: 'demo-alice',
      email: 'alice@demo.mores-hub.id',
      name: 'Alice Demo',
      kycTier: 'VERIFIED',
      pinHash,
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: 'bob@demo.mores-hub.id' },
    update: {},
    create: {
      googleSub: 'demo-bob',
      email: 'bob@demo.mores-hub.id',
      name: 'Bob Demo',
      kycTier: 'BASIC',
      pinHash,
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@demo.mores-hub.id' },
    update: {},
    create: {
      googleSub: 'demo-admin',
      email: 'admin@demo.mores-hub.id',
      name: 'Admin Demo',
      kycTier: 'ENHANCED',
      pinHash,
    },
  });

  await prisma.admin.upsert({
    where: { userId: adminUser.id },
    update: {},
    create: {
      userId: adminUser.id,
      role: 'SUPERADMIN',
      totpSecret: 'JBSWY3DPEHPK3PXP', // demo only
    },
  });

  for (const u of [alice, bob]) {
    const exists = await prisma.wallet.findFirst({ where: { ownerId: u.id } });
    if (!exists) {
      await prisma.wallet.create({
        data: {
          ownerId: u.id,
          name: 'Personal',
          access: { create: { userId: u.id, role: 'OWNER' } },
        },
      });
    }
  }

  // Shared family wallet — Alice owns, Bob has MEMBER access
  const aliceWallets = await prisma.wallet.findMany({ where: { ownerId: alice.id } });
  const familyExists = aliceWallets.find((w) => w.name === 'Family');
  if (!familyExists) {
    await prisma.wallet.create({
      data: {
        ownerId: alice.id,
        name: 'Family',
        type: 'SHARED',
        access: {
          create: [
            { userId: alice.id, role: 'OWNER' },
            { userId: bob.id, role: 'MEMBER' },
          ],
        },
      },
    });
  }

  console.log('\nDemo accounts (PIN = 123456 for all):');
  console.log('  alice@demo.mores-hub.id  (VERIFIED, owns Personal + Family)');
  console.log('  bob@demo.mores-hub.id    (BASIC, MEMBER of Family)');
  console.log('  admin@demo.mores-hub.id  (SUPERADMIN)\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
