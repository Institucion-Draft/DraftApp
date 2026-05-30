import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';

export type AuthStackParamList = {
  Login: undefined;
  SignUp: undefined;
};

const Stack = createNativeStackNavigator<AuthStackParamList>();

function LoginRoute({ navigation }: NativeStackScreenProps<AuthStackParamList, 'Login'>) {
  return <LoginScreen onNavigateToSignUp={() => navigation.navigate('SignUp')} />;
}

function SignUpRoute({ navigation }: NativeStackScreenProps<AuthStackParamList, 'SignUp'>) {
  return <SignUpScreen onNavigateToLogin={() => navigation.navigate('Login')} />;
}

export default function AuthStackNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Login"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#ffffff' },
      }}
    >
      <Stack.Screen name="Login" component={LoginRoute} />
      <Stack.Screen name="SignUp" component={SignUpRoute} />
    </Stack.Navigator>
  );
}
