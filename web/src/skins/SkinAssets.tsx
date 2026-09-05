import { createContext } from 'react';
import type { SkinDescriptor, SkinVariant } from './types';
export const SkinAssetsContext = createContext<{ skin: SkinDescriptor; variant: SkinVariant } | null>(null);
