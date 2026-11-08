import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { colors, radius, space, type, type ColorScheme, type Palette } from './tokens';

export interface Theme {
  scheme: ColorScheme;
  colors: Palette;
  type: typeof type;
  space: typeof space;
  radius: typeof radius;
}

const build = (scheme: ColorScheme): Theme => ({ scheme, colors: colors[scheme], type, space, radius });

const ThemeContext = createContext<Theme>(build('light'));

/**
 * Follows the system appearance (`userInterfaceStyle: 'automatic'`). `scheme` forces one, which the
 * screenshot harness and previews use; the app itself never overrides the user's choice.
 */
export function ThemeProvider({ children, scheme }: { children: ReactNode; scheme?: ColorScheme }) {
  const system = useColorScheme();
  const resolved: ColorScheme = scheme ?? (system === 'dark' ? 'dark' : 'light');
  const value = useMemo(() => build(resolved), [resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): Theme => useContext(ThemeContext);
