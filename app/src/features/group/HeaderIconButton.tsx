/**
 * Group-home nav-bar icon: the shared header button under the prop names this screen used
 * (`name` for the symbol), so every bar item presses the same way (0.97 scale, 120 ms).
 */
import type { IconName } from '../../components';
import { HeaderIconButton as SharedHeaderIconButton } from '../groups/headerButtons';

export { HeaderItems } from '../groups/headerButtons';

export interface HeaderIconButtonProps {
  name: IconName;
  /** VoiceOver name; the icon alone never carries meaning */
  label: string;
  onPress: () => void;
  hint?: string;
}

export function HeaderIconButton({ name, label, onPress, hint }: HeaderIconButtonProps) {
  return <SharedHeaderIconButton icon={name} label={label} hint={hint} onPress={onPress} />;
}
