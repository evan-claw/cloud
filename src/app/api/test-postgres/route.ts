import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

export async function GET(): Promise<NextResponse<{ dbWorks: number }>> {
  // Touch at least one row of a real table with minimal cost
  const rows = await db
    .select({ ok: sql<number>`1`.as('ok') })
    .from(kilocode_users)
    .limit(1);

  const dbWorks = rows.length > 0 ? 1 : 0;
  return NextResponse.json({ dbWorks }, { status: 200 });
}
