import { z } from 'zod';

export const contractSchema = z.object({ id: z.string() });
