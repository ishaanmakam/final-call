import { LegalScreen } from '@/features/legal/LegalScreen';
import { PRIVACY } from '@/features/legal/content';

/** Reachable signed out (sign-in footer) and signed in (Settings → About). Same text as docs/legal/PRIVACY.md. */
export default function Privacy() {
  return <LegalScreen doc={PRIVACY} />;
}
