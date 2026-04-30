import React from 'react';
import { Text, Pressable } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import WorkspacesListScreen from '../screens/WorkspacesListScreen';
import CreateWorkspaceScreen from '../screens/CreateWorkspaceScreen';
import WorkspaceDetailScreen from '../screens/WorkspaceDetailScreen';
import SearchWorkspacesScreen from '../screens/SearchWorkspacesScreen';
import MyJoinRequestsScreen from '../screens/MyJoinRequestsScreen';
import IncomingJoinRequestsScreen from '../screens/IncomingJoinRequestsScreen';
import GenerateInviteScreen from '../screens/GenerateInviteScreen';
import JoinByCodeScreen from '../screens/JoinByCodeScreen';
import type { MainStackParamList } from './mainStackParams';

export type { MainStackParamList } from './mainStackParams';

const Stack = createNativeStackNavigator<MainStackParamList>();

export default function MainNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShadowVisible: false,
          contentStyle: { backgroundColor: '#fff' },
        }}
      >
        <Stack.Screen
          name="WorkspacesList"
          component={WorkspacesListScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="CreateWorkspace"
          component={CreateWorkspaceScreen}
          options={({ navigation }) => ({
            title: 'Nuevo workspace',
            headerBackVisible: false,
            headerLeft: () => (
              <Pressable
                onPress={() => navigation.goBack()}
                hitSlop={12}
                style={stylesHeaderButton}
              >
                <Text style={stylesCancel}>Cancelar</Text>
              </Pressable>
            ),
          })}
        />
        <Stack.Screen
          name="WorkspaceDetail"
          component={WorkspaceDetailScreen}
          options={{
            title: 'Workspace',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="SearchWorkspaces"
          component={SearchWorkspacesScreen}
          options={{
            title: 'Buscar workspaces',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="MyJoinRequests"
          component={MyJoinRequestsScreen}
          options={{
            title: 'Mis solicitudes',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="IncomingJoinRequests"
          component={IncomingJoinRequestsScreen}
          options={{
            title: 'Solicitudes pendientes',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="GenerateInvite"
          component={GenerateInviteScreen}
          options={{
            title: 'Invitación',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="JoinByCode"
          component={JoinByCodeScreen}
          options={{
            title: 'Unirme con código',
            headerBackTitle: 'Atrás',
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const stylesHeaderButton = { paddingVertical: 4, paddingHorizontal: 4 };

const stylesCancel = {
  color: '#3B82F6',
  fontSize: 17,
  fontWeight: '400' as const,
};
