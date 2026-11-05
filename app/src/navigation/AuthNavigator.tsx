import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';
import { useTheme } from '../theme';

export type AuthStackParamList = {
  Login: undefined;
  SignUp: undefined;
};

const Stack = createNativeStackNavigator<AuthStackParamList>();

function LoginRoute({ navigation }: NativeStackScreenProps<AuthStackParamList, 'Login'>) {
  return <LoginScreen onNavigateToSignUp={() => navigation.navigate('SignUp')} />;
}

function SignUpRoute({ navigation }: NativeStackScreenProps<AuthStackParamList, 'SignUp'>) {
  return (
    <SignUpScreen
      onNavigateToLogin={() => navigation.navigate('Login')}
      // Tras crear la cuenta se vuelve al login y se saca SignUp del historial (reset), así no queda el formulario atrás.
      onSignUpComplete={() => navigation.reset({ index: 0, routes: [{ name: 'Login' }] })}
    />
  );
}

export default function AuthStackNavigator() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator
      initialRouteName="Login"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="Login" component={LoginRoute} />
      <Stack.Screen name="SignUp" component={SignUpRoute} />
    </Stack.Navigator>
  );
}
