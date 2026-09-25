import { StyleSheet } from 'react-native';
import { useThemedStyles } from '../../theme';
import type { ThemeColors } from '../../theme';

const createRulesStyles = (c: ThemeColors) =>
  StyleSheet.create({
    h2: { fontSize: 18, fontWeight: '700', color: c.text, marginTop: 4, marginBottom: 10 },
    h3: { fontSize: 15, fontWeight: '700', color: c.text, marginTop: 14, marginBottom: 8 },
    paragraph: { fontSize: 14, color: c.textBody, lineHeight: 20, marginBottom: 10 },
    exampleLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: c.accent,
      marginBottom: 6,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    card: { marginBottom: 12 },
    sectionDivider: { height: 1, backgroundColor: c.divider, marginVertical: 22 },
  });

/** Estilos compartidos de los contenidos del reglamento. Usar como `const rs = useRulesStyles();`. */
export function useRulesStyles() {
  return useThemedStyles(createRulesStyles);
}
