import React, { useEffect } from 'react';
import { View, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import RootNavigator from './src/navigation/RootNavigator';
import { ThemeProvider, useTheme } from './src/theme';
import { startPortraitGuard } from './src/lib/screenOrientationPolicy';
import { AppAlertHost, installAppAlert } from './src/lib/appAlert';

// Los carteles (Alert.alert) pasan a ser un Modal solo vertical: ver src/lib/appAlert.tsx.
installAppAlert();

function AppContent() {
  const { loading } = useAuth();
  const { mode, colors } = useTheme();

  if (loading) {
    return <View style={[styles.loadingContainer, { backgroundColor: colors.background }]} />;
  }

  return (
    <>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      <RootNavigator />
    </>
  );
}

export default function App() {
  // Guarda global de orientación: la app es vertical salvo las pantallas que piden landscape.
  useEffect(() => startPortraitGuard(), []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
        <AppAlertHost />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
  },
});
