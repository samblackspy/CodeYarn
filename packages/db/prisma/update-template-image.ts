import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.template.update({
    where: { id: 'node-basic' },
    data: {
      dockerImage: 'codeyarn-node-basic',
    },
  });
  console.log('Updated node-basic template to use codeyarn-node-basic image.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
