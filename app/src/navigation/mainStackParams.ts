export type MainStackParamList = {
  WorkspacesList: undefined;
  CreateWorkspace: undefined;
  WorkspaceDetail: { workspaceId: string };
  SearchWorkspaces: undefined;
  MyJoinRequests: undefined;
  IncomingJoinRequests: { workspaceId: string };
  GenerateInvite: { workspaceId: string };
  JoinByCode: undefined;
};
