export type MainStackParamList = {
  WorkspacesList: undefined;
  MyProfile: { from?: 'WorkspacesList' | 'WorkspaceDetail'; workspaceId?: string };
  MemberProfile: { userId: string; workspaceId: string };
  CreateWorkspace: undefined;
  WorkspaceDetail: { workspaceId: string };
  SearchWorkspaces: undefined;
  MyJoinRequests: undefined;
  IncomingJoinRequests: { workspaceId: string };
  GenerateInvite: { workspaceId: string };
  JoinByCode: undefined;
  CubesList: { workspaceId: string };
  CreateCube: { workspaceId: string };
  CubeDetail: { cubeId: string };
  EditCube: { cubeId: string };
  VenuesList: { workspaceId: string };
  CreateVenue: { workspaceId: string };
  EditVenue: { venueId: string };
  EventsList: { workspaceId: string };
  CreateEvent: { workspaceId: string };
  EventDetail: { eventId: string };
  ProDeC: { eventId: string };
  EditEvent: { eventId: string };
  EventCheckIn: {
    eventId: string;
    returnTo?: 'PairingsList' | 'EventDetail' | 'PairingDetail' | 'PlayerProfileInEvent';
    /** Requerido si returnTo es PairingDetail. */
    pairingId?: string;
    /** Requerido si returnTo es PlayerProfileInEvent. */
    participantId?: string;
    /** Pantalla lógica de vuelta al cerrar perfil (se reenvía al volver desde Mi mazo). */
    profileReturnFrom?: 'Standings' | 'EventDetail';
  };
  PlayerProfileInEvent: {
    eventId: string;
    participantId: string;
    /** Origen de navegación para el botón Atrás del header. */
    from?: 'Standings' | 'EventDetail';
  };
  PairingsList: { eventId: string; initialTab?: 'official' | 'revenge' };
  PairingDetail: { pairingId: string; fromTab?: 'official' | 'revenge' };
  CubeRoulette: { eventId: string };
  /** `fromTab` conserva la pestaña de PairingsList al volver desde LifeTracker a PairingDetail. */
  LifeTracker: { matchId: string; fromTab?: 'official' | 'revenge' };
  LifeChart: { matchId: string };
  MatchResult: { matchId: string };
  Standings: { eventId: string; showPodiumIntro?: boolean };
};
