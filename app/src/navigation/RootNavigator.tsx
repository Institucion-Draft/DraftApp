import React, { useEffect } from 'react';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import WelcomeScreen from '../screens/WelcomeScreen';
import AuthStackNavigator from './AuthNavigator';
import MainStackNavigator from './MainNavigator';
import type { RootStackParamList } from './rootStackParams';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { loading } = useAuth();
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  useEffect(() => {
    if (loading) return undefined;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!navigationRef.isReady()) return;

      if (event === 'SIGNED_OUT') {
        navigationRef.reset({ index: 0, routes: [{ name: 'Welcome' }] });
        return;
      }

      if (event === 'SIGNED_IN' && session) {
        const root = navigationRef.getRootState();
        const current = root.routes[root.index]?.name;
        if (current === 'Auth') {
          navigationRef.reset({ index: 0, routes: [{ name: 'Main' }] });
        }
      }
    });

    return () => subscription.unsubscribe();
  }, [loading, navigationRef]);

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        initialRouteName="Welcome"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#ffffff' },
        }}
      >
        <Stack.Screen name="Welcome" component={WelcomeScreen} />
        <Stack.Screen name="Auth" component={AuthStackNavigator} />
        <Stack.Screen name="Main" component={MainStackNavigator} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
