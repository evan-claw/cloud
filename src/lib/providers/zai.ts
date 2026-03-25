import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';

export function isZaiModel(model: string) {
  return model.startsWith('z-ai/');
}
