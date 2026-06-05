import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Admin12345', 10);

  await prisma.appUser.upsert({
    where: { email: 'admin@test.com' },
    update: { passwordHash, role: Role.ADMIN },
    create: { email: 'admin@test.com', passwordHash, role: Role.ADMIN },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
  });
