import { prisma } from '../db/prisma_bridge.mjs';

export async function findUserByEmail(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return await prisma.executeQuery('users', { email: normalized });
}
