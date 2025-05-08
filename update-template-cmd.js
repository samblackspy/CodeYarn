// Direct database update script
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function updateTemplate() {
  try {
    const result = await prisma.template.update({
      where: { id: 'node-basic' },
      data: { startCommand: '/bin/sh' }
    });
    console.log('Updated template:', result);
  } catch (error) {
    console.error('Error updating template:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateTemplate();
