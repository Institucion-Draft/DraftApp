import React, { useState } from 'react';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';

type Screen = 'login' | 'signup';

export default function AuthNavigator() {
  const [screen, setScreen] = useState<Screen>('login');

  if (screen === 'login') {
    return <LoginScreen onNavigateToSignUp={() => setScreen('signup')} />;
  }

  return <SignUpScreen onNavigateToLogin={() => setScreen('login')} />;
}