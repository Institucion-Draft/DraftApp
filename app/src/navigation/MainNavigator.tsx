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
import CubesListScreen from '../screens/CubesListScreen';
import CreateCubeScreen from '../screens/CreateCubeScreen';
import CubeDetailScreen from '../screens/CubeDetailScreen';
import EditCubeScreen from '../screens/EditCubeScreen';
import VenuesListScreen from '../screens/VenuesListScreen';
import CreateVenueScreen from '../screens/CreateVenueScreen';
import EditVenueScreen from '../screens/EditVenueScreen';
import EventsListScreen from '../screens/EventsListScreen';
import CreateEventScreen from '../screens/CreateEventScreen';
import EventDetailScreen from '../screens/EventDetailScreen';
import EditEventScreen from '../screens/EditEventScreen';
import EventCheckInScreen from '../screens/EventCheckInScreen';
import PlayerProfileInEventScreen from '../screens/PlayerProfileInEventScreen';
import PairingsListScreen from '../screens/PairingsListScreen';
import PairingDetailScreen from '../screens/PairingDetailScreen';
import CubeRouletteScreen from '../screens/CubeRouletteScreen';
import LifeTrackerScreen from '../screens/LifeTrackerScreen';
import MatchResultScreen from '../screens/MatchResultScreen';
import StandingsScreen from '../screens/StandingsScreen';
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
            title: 'Nuevo grupo de Draft',
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
            title: 'Detalle del grupo',
            headerBackTitle: 'Atrás',
          }}
        />
        <Stack.Screen
          name="SearchWorkspaces"
          component={SearchWorkspacesScreen}
          options={{
            title: 'Buscar grupos de Draft',
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
        <Stack.Screen name="CubesList" component={CubesListScreen} options={{ title: 'Cubos', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="CreateCube" component={CreateCubeScreen} options={{ title: 'Nuevo cubo', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="CubeDetail" component={CubeDetailScreen} options={{ title: 'Cubo', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="EditCube" component={EditCubeScreen} options={{ title: 'Editar cubo', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="VenuesList" component={VenuesListScreen} options={{ title: 'Sedes', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="CreateVenue" component={CreateVenueScreen} options={{ title: 'Nueva sede', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="EditVenue" component={EditVenueScreen} options={{ title: 'Editar sede', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="EventsList" component={EventsListScreen} options={{ title: 'Eventos', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="CreateEvent" component={CreateEventScreen} options={{ title: 'Nuevo evento', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="EventDetail" component={EventDetailScreen} options={{ title: 'Evento', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="EditEvent" component={EditEventScreen} options={{ title: 'Editar evento', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="EventCheckIn" component={EventCheckInScreen} options={{ title: 'Mi mazo', headerBackTitle: 'Atrás' }} />
        <Stack.Screen
          name="PlayerProfileInEvent"
          component={PlayerProfileInEventScreen}
          options={{ title: 'Perfil del Jugador', headerBackTitle: 'Atrás' }}
        />
        <Stack.Screen name="PairingsList" component={PairingsListScreen} options={{ title: 'Enfrentamientos', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="PairingDetail" component={PairingDetailScreen} options={{ title: 'Enfrentamiento', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="CubeRoulette" component={CubeRouletteScreen} options={{ title: 'Ruleta de cubos', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="LifeTracker" component={LifeTrackerScreen} options={{ title: 'Life Tracker', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="MatchResult" component={MatchResultScreen} options={{ title: 'Resultado', headerBackTitle: 'Atrás' }} />
        <Stack.Screen name="Standings" component={StandingsScreen} options={{ title: 'Tabla de posiciones', headerBackTitle: 'Atrás' }} />
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
