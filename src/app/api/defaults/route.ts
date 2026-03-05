import { NextResponse } from 'next/server';
import { KILO_AUTO_FREE_MODEL, KILO_AUTO_FRONTIER_MODEL } from '@/lib/kilo-auto-model';

type DefaultsResponse = {
  defaultModel: string;
  defaultFreeModel: string;
};

export async function GET(): Promise<NextResponse<DefaultsResponse>> {
  return NextResponse.json({
    defaultModel: KILO_AUTO_FRONTIER_MODEL.id,
    defaultFreeModel: KILO_AUTO_FREE_MODEL.id,
  });
}
