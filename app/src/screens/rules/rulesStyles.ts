import { StyleSheet } from 'react-native';

export const rulesStyles = StyleSheet.create({
  h2: { fontSize: 18, fontWeight: '700', color: '#111', marginTop: 4, marginBottom: 10 },
  h3: { fontSize: 15, fontWeight: '700', color: '#111', marginTop: 14, marginBottom: 8 },
  paragraph: { fontSize: 14, color: '#374151', lineHeight: 20, marginBottom: 10 },
  exampleLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#3B82F6',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  card: { marginBottom: 12 },
  sectionDivider: { height: 1, backgroundColor: '#eee', marginVertical: 22 },
});
