import { LegalScreen } from '@/features/legal/LegalScreen';
import { TERMS } from '@/features/legal/content';

/** Reachable signed out (sign-in footer) and signed in (Settings → About). Same text as docs/legal/TERMS.md. */
export default function Terms() {
  return <LegalScreen doc={TERMS} />;
}
