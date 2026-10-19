import { createContext, useContext } from 'react';
import type { Textures } from './gfx/textures';

export const TexContext = createContext<Textures | null>(null);
export function useTextures(): Textures {
  const t = useContext(TexContext);
  if (!t) throw new Error('textures not available');
  return t;
}
