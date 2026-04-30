/**
 * Tipos parciales de la base (Supabase). Ampliar cuando se generen los tipos completos.
 */

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatar_path: string | null;
  created_by: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type WorkspaceMember = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'organizer' | 'member';
  joined_at: string;
};

export type WorkspaceJoinRequestStatus = 'pending' | 'approved' | 'rejected';

export type WorkspaceJoinRequest = {
  id: string;
  workspace_id: string;
  user_id: string;
  message: string | null;
  status: WorkspaceJoinRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};
