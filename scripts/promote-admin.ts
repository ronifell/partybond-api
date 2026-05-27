/**
 * Bootstrap script: promote a user to admin (or create one if missing).
 *
 * Usage:
 *   npx tsx scripts/promote-admin.ts <email>
 *   npx tsx scripts/promote-admin.ts <email> <password> "<Name>" <age>
 *
 * - If the user exists, sets is_admin = true.
 * - If the user doesn't exist and password+name+age were provided, creates a new admin.
 *
 * After running, log into the admin panel with the same email + password.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/database';

async function main() {
  const [emailArg, passwordArg, nameArg, ageArg] = process.argv.slice(2);
  const email = (emailArg ?? '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: tsx scripts/promote-admin.ts <email> [<password> "<name>" <age>]');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: { isAdmin: true, bannedAt: null, banReason: null },
      select: { id: true, email: true, name: true, isAdmin: true },
    });
    console.log('Promoted existing user to admin:', updated);
    return;
  }

  if (!passwordArg || !nameArg || !ageArg) {
    console.error(
      'User not found. To create a new admin, run with:\n' +
        '  tsx scripts/promote-admin.ts <email> <password> "<Full Name>" <age>',
    );
    process.exit(2);
  }

  const ageNum = Number.parseInt(ageArg, 10);
  if (!Number.isFinite(ageNum) || ageNum < 13 || ageNum > 120) {
    console.error('Invalid age. Must be an integer between 13 and 120.');
    process.exit(3);
  }
  if (passwordArg.length < 6) {
    console.error('Password must be at least 6 characters long.');
    process.exit(4);
  }

  const passwordHash = await bcrypt.hash(passwordArg, 10);
  const created = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: nameArg,
      age: ageNum,
      isAdmin: true,
      locale: 'pt',
    },
    select: { id: true, email: true, name: true, isAdmin: true },
  });
  console.log('Created new admin user:', created);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(99);
  })
  .finally(() => prisma.$disconnect());
